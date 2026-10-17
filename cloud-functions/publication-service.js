import { randomUUID, createHash } from 'node:crypto';
import { PUBLIC_ORIGIN, articlePath, assetPath, emptyRelease, normalizeRelease } from '../publication-model.js';

const STATE_KEY = 'publication/state-v1.json';
const IMAGE_REF = /!\[([^\]\n]*)\]\(\/api\/author\/images\/([a-f0-9-]{36})\)/g;
export class PublicationError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new PublicationError(status, message); };

export function createPublicationService({ read, write, readDraft, env, fetchImpl, now, ownerId }) {
  const configured = () => env.AUTH_ORIGIN === PUBLIC_ORIGIN && /^https:\/\//.test(env.PUBLICATION_DEPLOY_HOOK || '');
  async function load() {
    const stored = await read(STATE_KEY);
    if (!stored) return { release: emptyRelease(), bindings: [], operation: null };
    stored.release = normalizeRelease(stored.release);
    if (!Array.isArray(stored.bindings)) throw new Error('Invalid publication state');
    return stored;
  }
  async function liveRelease() {
    try {
      const response = await fetchImpl(PUBLIC_ORIGIN + '/__publication_probe.json?check=' + now(), { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(6000) });
      if (!response.ok) return null;
      const live = await response.json();
      return live.schema === 1 && typeof live.releaseId === 'string' && Array.isArray(live.slugs) ? live : null;
    } catch { return null; }
  }
  async function describe(state) {
    const live = state.operation ? await liveRelease() : null;
    let phase = configured() ? 'idle' : 'unconfigured';
    if (state.operation) {
      if (live?.releaseId === state.release.releaseId) phase = 'live';
      else if (state.operation.triggerError) phase = 'trigger-failed';
      else phase = now() - state.operation.requestedAt > 180000 ? 'unconfirmed' : 'building';
    }
    return {
      configured: configured(), phase, releaseId: state.release.releaseId,
      liveReleaseId: live?.releaseId || null,
      operation: state.operation,
      published: state.bindings.map(binding => ({ ...binding, url: PUBLIC_ORIGIN + articlePath(binding.slug) })),
      indexUrl: PUBLIC_ORIGIN + '/publication-proof/'
    };
  }
  async function freezeDraft(draft, slug) {
    const ids = [...new Set([...draft.body.matchAll(IMAGE_REF)].map(match => match[2]))];
    const replacements = new Map();
    const assets = [];
    for (const id of ids) {
      const image = await read('images/' + id + '.json');
      if (!image || String(image.ownerId) !== String(ownerId)) fail(400, '正文中的私有图片不存在，请重新上传后保存。');
      const bytes = Buffer.from(image.data, 'base64');
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (hash !== image.sha256) fail(503, '测试图片完整性检查未通过。');
      const asset = { hash, mime: image.mime, data: image.data };
      assets.push(asset);
      replacements.set(id, assetPath(asset));
    }
    const body = draft.body.replace(IMAGE_REF, (_, alt, id) => '![' + alt + '](' + replacements.get(id) + ')');
    if (body.includes('/api/author/')) fail(400, '正文含有未处理的私有地址，请仅使用上传按钮插入的图片引用。');
    return {
      article: { slug, title: draft.title, body, tags: [...draft.tags], publishedAt: new Date(now()).toISOString(), assetHashes: assets.map(asset => asset.hash) },
      assets
    };
  }
  async function trigger(state) {
    // Persist only the explicitly selected, frozen publication; never the hook URL.
    state.operation.triggerError = null;
    state.operation.requestedAt = now();
    await write(STATE_KEY, state);
    try {
      const response = await fetchImpl(env.PUBLICATION_DEPLOY_HOOK, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        redirect: 'error', signal: AbortSignal.timeout(10000)
      });
      await response.arrayBuffer();
      if (!response.ok) state.operation.triggerError = '构建触发请求返回 HTTP ' + response.status + '，请重试。';
    } catch {
      state.operation.triggerError = '构建触发结果未确认，请稍后检查或重试。';
    }
    if (state.operation.triggerError) await write(STATE_KEY, state);
    return { accepted: !state.operation.triggerError, releaseId: state.release.releaseId, operation: state.operation };
  }
  async function change(input) {
    if (!configured()) fail(503, '测试发布钩子尚未配置。');
    const state = await load();
    if (input.action === 'retry') {
      if (!state.operation) fail(400, '当前没有可重试的发布请求。');
      return trigger(state);
    }
    if (!['publish', 'withdraw'].includes(input.action) || !/^[a-f0-9-]{36}$/.test(input.draftId || '')) fail(400, '发布请求不正确。');
    const status = await describe(state);
    if (status.phase === 'building') fail(409, '上一次构建尚未确认上线，请稍后再操作。');
    const draft = await readDraft(input.draftId);
    if (!draft || String(draft.ownerId) !== String(ownerId)) fail(404, '测试草稿不存在。');
    if (draft.revision !== input.revision) fail(409, '草稿已更新，请重新打开并确认保存版本后发布或撤回。');
    const prior = state.bindings.find(binding => binding.draftId === draft.id);
    if (input.action === 'withdraw' && !prior) fail(400, '这篇草稿没有待撤回的测试发布版本。');
    const slug = prior?.slug || 'probe-' + randomUUID();
    state.release.articles = state.release.articles.filter(article => article.slug !== slug);
    state.bindings = state.bindings.filter(binding => binding.draftId !== draft.id);
    if (input.action === 'publish') {
      const frozen = await freezeDraft(draft, slug);
      state.release.articles.push(frozen.article);
      state.bindings.push({ draftId: draft.id, slug, sourceRevision: draft.revision });
      const assets = new Map(state.release.assets.map(asset => [asset.hash, asset]));
      for (const asset of frozen.assets) assets.set(asset.hash, asset);
      state.release.assets = [...assets.values()];
    }
    const used = new Set(state.release.articles.flatMap(article => article.assetHashes));
    state.release.assets = state.release.assets.filter(asset => used.has(asset.hash));
    state.release.releaseId = randomUUID();
    state.release.createdAt = new Date(now()).toISOString();
    try { state.release = normalizeRelease(state.release); }
    catch { fail(413, '测试公开快照超出限制或格式不支持，请减少文章或图片后重试（快照最多 4 MiB）。'); }
    state.operation = { action: input.action, draftId: draft.id, requestedAt: now(), triggerError: null };
    return trigger(state);
  }
  return { configured, change, status: async () => describe(await load()), publicSnapshot: async () => normalizeRelease((await load()).release) };
}
