import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createPublicationService } from '../cloud-functions/publication-service.js';
import { normalizeRelease, emptyRelease, PUBLIC_ORIGIN, assetPath, articlePath } from '../publication-model.js';
import { fetchPublication, buildPublication } from '../publication-build.js';
import { saveRecovery, readRecovery, clearRecovery, sessionExpired } from '../author-probe/session.js';

function setup({ configured = true, hookStatus = 200 } = {}) {
  const rows = new Map(), drafts = new Map(), calls = [];
  const imageId = randomUUID(); const bytes = Buffer.from('synthetic-unit-image');
  const image = { ownerId: '103913273', mime: 'image/png', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
  rows.set('images/' + imageId + '.json', image);
  const draft = { id: randomUUID(), revision: randomUUID(), ownerId: '103913273', title: '合成发布 A', body: 'PUBLIC_A\n![测试图](/api/author/images/' + imageId + ')', tags: ['测试'] };
  drafts.set(draft.id, draft);
  drafts.set(randomUUID(), { body: 'PRIVATE_CONTROL_DO_NOT_EXPORT', ownerId: '103913273' });
  let live = emptyRelease(), time = Date.now();
  const service = createPublicationService({
    read: async key => structuredClone(rows.get(key) || null),
    write: async (key, value) => { rows.set(key, structuredClone(value)); },
    readDraft: async id => structuredClone(drafts.get(id)),
    env: { AUTH_ORIGIN: PUBLIC_ORIGIN, PUBLICATION_DEPLOY_HOOK: configured ? 'https://hook.example.test/synthetic-only' : '' }, ownerId: '103913273', now: () => time++,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options?.method || 'GET' });
      if (url === 'https://hook.example.test/synthetic-only') return new Response('{}', { status: hookStatus });
      assert(url.startsWith(PUBLIC_ORIGIN + '/__publication_probe.json?'));
      return Response.json({ schema: 1, releaseId: live.releaseId, slugs: live.articles.map(article => article.slug) });
    }
  });
  return { service, draft, drafts, rows, imageId, image, bytes, calls, setLive: value => { live = value; }, advance: value => { time += value; } };
}
const publish = app => app.service.change({ action: 'publish', draftId: app.draft.id, revision: app.draft.revision });

test('publishing freezes only the selected draft, converts its images, and strips private metadata', async () => {
  const app = setup(); await publish(app);
  const snapshot = await app.service.publicSnapshot();
  assert.equal(snapshot.articles.length, 1); assert.equal(snapshot.assets.length, 1);
  assert(snapshot.articles[0].body.includes(assetPath(snapshot.assets[0])));
  assert.equal(snapshot.assets[0].data, app.image.data);
  const text = JSON.stringify(snapshot);
  for (const privateValue of ['PRIVATE_CONTROL_DO_NOT_EXPORT', '/api/author/', 'ownerId', 'sourceRevision', app.draft.id, app.imageId, 'synthetic-only']) assert(!text.includes(privateValue), privateValue);
  app.draft.body = 'PRIVATE_B_NOT_PUBLISHED'; app.draft.revision = randomUUID();
  assert.deepEqual(await app.service.publicSnapshot(), snapshot);
  assert.equal((await app.service.status()).phase, 'building');
  app.setLive(snapshot); assert.equal((await app.service.status()).phase, 'live');
});

test('stale revisions, missing configuration and private image paths cannot mutate a release', async () => {
  const app = setup();
  await assert.rejects(app.service.change({ action: 'publish', draftId: app.draft.id, revision: 'outdated' }), error => error.status === 409);
  assert.equal(app.rows.size, 1);
  const off = setup({ configured: false }); await assert.rejects(publish(off), error => error.status === 503); assert.equal(off.rows.size, 1);
  app.draft.body = 'unprocessed /api/author/drafts/private'; await assert.rejects(publish(app), error => error.status === 400); assert.equal(app.rows.size, 1);
});

test('hook failure is not deployment success; delayed deployment remains explicitly unconfirmed', async () => {
  const app = setup({ hookStatus: 503 }); const result = await publish(app);
  assert.equal(result.accepted, false); assert.equal((await app.service.status()).phase, 'trigger-failed');
  assert(!JSON.stringify([...app.rows.values()]).includes('hook.example.test'));
  const delayed = setup(); await publish(delayed); delayed.advance(181000);
  assert.equal((await delayed.service.status()).phase, 'unconfirmed');
});

test('withdrawal removes public content and unreferenced assets while keeping the private draft and image', async () => {
  const app = setup(); await publish(app); const first = await app.service.publicSnapshot(); app.setLive(first);
  await app.service.change({ action: 'withdraw', draftId: app.draft.id, revision: app.draft.revision });
  const withdrawn = await app.service.publicSnapshot();
  assert.equal(withdrawn.articles.length, 0); assert.equal(withdrawn.assets.length, 0); assert.notEqual(withdrawn.releaseId, first.releaseId);
  assert(app.drafts.has(app.draft.id)); assert(app.rows.has('images/' + app.imageId + '.json'));
  assert.equal((await app.service.status()).phase, 'building');
  app.setLive(withdrawn); assert.equal((await app.service.status()).phase, 'live');
});

test('renderer emits article/list/RSS/image/marker, escapes markup, and withdrawal emits no old article', async () => {
  const app = setup(); app.draft.title = '<script>synthetic</script>'; await publish(app);
  const snapshot = await app.service.publicSnapshot(); const output = await fs.mkdtemp(path.resolve('.publication-test-'));
  const marker = await buildPublication(snapshot, output);
  assert.equal(marker.releaseId, snapshot.releaseId);
  const article = await fs.readFile(path.join(output, articlePath(snapshot.articles[0].slug), 'index.html'), 'utf8');
  assert(article.includes('&lt;script&gt;synthetic&lt;/script&gt;')); assert(!article.includes('<script>'));
  assert(article.includes(assetPath(snapshot.assets[0])));
  assert.deepEqual(await fs.readFile(path.join(output, assetPath(snapshot.assets[0]))), app.bytes);
  assert((await fs.readFile(path.join(output, 'publication-proof/rss.xml'), 'utf8')).includes(PUBLIC_ORIGIN + articlePath(snapshot.articles[0].slug)));
  const emptyOutput = await fs.mkdtemp(path.resolve('.publication-test-'));
  await buildPublication(emptyRelease(), emptyOutput);
  await assert.rejects(fs.stat(path.join(emptyOutput, articlePath(snapshot.articles[0].slug))), { code: 'ENOENT' });
  // Evidence outputs stay in the ignored test checkout; no recursive cleanup.
});

test('build fails closed on unavailable, overlarge or malformed snapshots', async () => {
  await assert.rejects(fetchPublication(async () => new Response('', { status: 503 })), /HTTP 503/);
  await assert.rejects(fetchPublication(async () => new Response('x'.repeat(4 * 1024 * 1024 + 1))), /4 MiB/);
  const app = setup(); await publish(app); const good = await app.service.publicSnapshot();
  for (const mutate of [value => { value.articles[0].slug = '../../outside'; }, value => { value.assets[0].hash = 'a'.repeat(64); }, value => { value.createdAt = { private: true }; }]) {
    const bad = structuredClone(good); mutate(bad); assert.throws(() => normalizeRelease(bad));
  }
  assert.deepEqual(await fetchPublication(async url => { assert.equal(url, PUBLIC_ORIGIN + '/api/author/public-snapshot'); return Response.json(good); }), good);
});

test('relogin recovery preserves unsaved text for this tab, expires, and can be cleared', () => {
  const values = new Map(); const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const state = { base: { title: '草稿', body: '已保存', tags: [] }, editor: { title: '草稿', body: '尚未保存文字', tags: ['测试'] } };
  assert(saveRecovery(storage, state, 1000)); assert.deepEqual(readRecovery(storage, 2000).editor, state.editor);
  assert(sessionExpired(1000, 1001)); assert(!sessionExpired(2000, 1001));
  clearRecovery(storage); assert.equal(readRecovery(storage, 2000), null);
  assert(saveRecovery(storage, state, 1000)); assert.equal(readRecovery(storage, 86401001), null); assert.equal(values.size, 0);
  assert.equal(saveRecovery(null, state), false);
});
