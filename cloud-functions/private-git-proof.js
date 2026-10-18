import { createHash } from 'node:crypto';
import {
  contentConfiguration,
  openPrivateGit,
  GitProbeError,
} from './private-git-client.js';
import { syntheticPng } from './private-git-fixture.js';

const hash = (raw) => createHash('sha256').update(raw).digest('hex');
const requireResult = (condition, message, status = 503) => {
  if (!condition) throw new GitProbeError(message, status);
};
const same = (actual, expected, message) =>
  requireResult(actual === expected, message);

function initialMarkdown(id, published = false) {
  return `---\ntitle: 私有 Git 合成验证\nslug: git-proof-${id}\ndescription: 合成数据，不是正式文章\ndate: 2026-10-18\ntags: [测试, 手机]\ndraft: ${!published}\nsample: true\nseries: synthetic-series\nseriesOrder: 1\nproduct: synthetic-product\nupdatedDate: 2026-10-18\nupdateNote: 合成修订说明\narticleId: ${id}\ncustomMap:\n  nested: [one, two] # preserve extension\n---\n\nGIT_PRIVATE_BODY_A_${id}\n\n![测试图片](/api/author/git-content-proof/image/${id})\n`;
}

// Fixed synthetic workflow only. Existing author handler supplies owner auth and CSRF checks.
export function createGitContentProof({
  env,
  read,
  write,
  provePrivate,
  fetchImpl = fetch,
  openGit,
}) {
  const connect = () =>
    openGit ? openGit() : openPrivateGit({ env, fetchImpl });
  function keys(id) {
    requireResult(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        id,
      ),
      '合成验证 ID 无效。',
      400,
    );
    return {
      root: `git-proof/${id}`,
      working: `working/probe-${id}.md`,
      published: `published/probe-${id}.md`,
      recovered: `recovered/probe-${id}.md`,
      recoveredPublished: `recovered-published/probe-${id}.md`,
    };
  }
  async function getRecord(id) {
    const k = keys(id);
    const record = await read(k.root + '/record.json');
    requireResult(record?.id === id, '请先创建本次合成样本。', 409);
    return { k, record };
  }
  async function create(id) {
    const k = keys(id);
    requireResult(
      !(await read(k.root + '/record.json')),
      '本次样本已经存在，请读取结果。',
      409,
    );
    const git = await connect();
    const image = {
      mime: 'image/png',
      sha256: hash(syntheticPng),
      data: syntheticPng.toString('base64'),
    };
    await write(k.root + '/source-image.json', image);
    const anonymousImageStatus = await provePrivate(
      k.root + '/source-image.json',
    );
    same(
      (await read(k.root + '/source-image.json'))?.sha256,
      image.sha256,
      '图片持久化读回失败。',
    );
    const initial = initialMarkdown(id),
      published = initialMarkdown(id, true);
    const created = await git.write(k.working, initial);
    same(created.status, 201, '工作稿未确认创建，请保留本次 ID 检查。');
    const frozen = await git.write(k.published, published);
    same(frozen.status, 201, '发表快照未确认创建，请保留本次 ID 检查。');
    same((await git.read(k.working)).raw, initial, '工作稿字节不一致。');
    same((await git.read(k.published)).raw, published, '发表快照字节不一致。');
    const record = {
      id,
      scope: git.evidence,
      phase: 'created',
      initialSha: created.sha,
      imageSha256: image.sha256,
      imageLocation: 'source-image',
      anonymousImageStatus,
    };
    await write(k.root + '/record.json', record);
    return record;
  }
  async function race(id) {
    const { k, record } = await getRecord(id);
    requireResult(record.phase === 'created', '并发步骤不允许重复执行。', 409);
    const git = await connect();
    const current = await git.read(k.working);
    same(
      current.raw,
      initialMarkdown(id),
      '工作稿已有变化，请先核对，不能重跑覆盖。',
    );
    const candidateB = current.raw.replace(
      'GIT_PRIVATE_BODY_A_',
      'GIT_PRIVATE_BODY_B_',
    );
    const candidateC = current.raw.replace(
      'GIT_PRIVATE_BODY_A_',
      'GIT_PRIVATE_BODY_C_',
    );
    const responses = await Promise.all([
      git.write(k.working, candidateB, current.sha),
      git.write(k.working, candidateC, current.sha),
    ]);
    const statuses = responses.map((r) => r.status);
    requireResult(
      statuses.filter((x) => x === 200).length === 1 &&
        statuses.filter((x) => x === 409).length === 1,
      '真实并发结果不符合一胜一冲突，需要检查，不能判通过。',
    );
    const winner = statuses[0] === 200 ? 'B' : 'C';
    const expected = winner === 'B' ? candidateB : candidateC;
    const latest = await git.read(k.working);
    same(latest.raw, expected, '胜出正文与实际版本不一致。');
    same(
      (await git.read(k.published)).raw,
      initialMarkdown(id, true),
      '保存意外改变了发表快照。',
    );
    const stale = await git.write(
      k.working,
      'SHOULD_NOT_BE_SAVED',
      current.sha,
    );
    same(stale.status, 409, '过期写未按预期拒绝。');
    const duplicate = await git.write(k.working, 'SHOULD_NOT_REPLACE_EXISTING');
    requireResult([409, 422].includes(duplicate.status), '重复创建未被拒绝。');
    same(
      (await git.read(k.working)).raw,
      expected,
      '冲突请求覆盖了有效工作稿。',
    );
    const next = {
      ...record,
      phase: 'race-passed',
      raceStatuses: statuses,
      winner,
      workingSha: latest.sha,
      staleStatus: stale.status,
      duplicateStatus: duplicate.status,
      publishedUnchanged: true,
    };
    await write(k.root + '/record.json', next);
    return next;
  }
  async function backup(id) {
    const { k, record } = await getRecord(id);
    requireResult(
      record.phase === 'race-passed',
      '请先完成真实并发验证。',
      409,
    );
    const git = await connect();
    const working = await git.read(k.working);
    const published = await git.read(k.published);
    same(
      working.sha,
      record.workingSha,
      '工作稿已有新变化，停止备份本次样本。',
    );
    const image = await read(k.root + '/source-image.json');
    same(
      hash(Buffer.from(image.data, 'base64')),
      record.imageSha256,
      '源图片内容损坏。',
    );
    const archive = {
      id,
      working: working.raw,
      published: published.raw,
      workingSha256: hash(working.raw),
      publishedSha256: hash(published.raw),
      image,
    };
    await write(k.root + '/backup.json', archive);
    const anonymousBackupStatus = await provePrivate(k.root + '/backup.json');
    same(
      JSON.stringify(await read(k.root + '/backup.json')),
      JSON.stringify(archive),
      '备份持久化不一致。',
    );
    const next = {
      ...record,
      phase: 'backed-up',
      anonymousBackupStatus,
      workingSha256: archive.workingSha256,
      publishedSha256: archive.publishedSha256,
    };
    await write(k.root + '/record.json', next);
    return next;
  }
  async function restore(id) {
    const { k, record } = await getRecord(id);
    requireResult(record.phase === 'backed-up', '请先备份本次样本。', 409);
    const archive = await read(k.root + '/backup.json');
    requireResult(archive?.id === id, '备份不存在或身份不一致。');
    same(hash(archive.working), record.workingSha256, '备份正文校验失败。');
    same(hash(archive.published), record.publishedSha256, '备份快照校验失败。');
    same(
      hash(Buffer.from(archive.image.data, 'base64')),
      record.imageSha256,
      '备份图片校验失败。',
    );
    const git = await connect();
    same(
      (await git.write(k.recovered, archive.working)).status,
      201,
      '恢复工作稿未确认创建。',
    );
    same(
      (await git.write(k.recoveredPublished, archive.published)).status,
      201,
      '恢复快照未确认创建。',
    );
    same(
      (await git.read(k.recovered)).raw,
      archive.working,
      '恢复工作稿字节不一致。',
    );
    same(
      (await git.read(k.recoveredPublished)).raw,
      archive.published,
      '恢复发表快照字节不一致。',
    );
    await write(k.root + '/restored-image.json', archive.image);
    const restoredImage = await read(k.root + '/restored-image.json');
    same(
      hash(Buffer.from(restoredImage.data, 'base64')),
      record.imageSha256,
      '恢复图片不一致。',
    );
    const anonymousRestoredImageStatus = await provePrivate(
      k.root + '/restored-image.json',
    );
    const next = {
      ...record,
      phase: 'restored',
      imageLocation: 'restored-image',
      anonymousRestoredImageStatus,
      restoredMarkdownExact: true,
      restoredImageExact: true,
      stableSlugPreserved: true,
    };
    await write(k.root + '/record.json', next);
    return next;
  }
  return {
    configuration: () => contentConfiguration(env),
    async step(step, id) {
      const action = { create, race, backup, restore }[step];
      requireResult(
        Object.hasOwn({ create, race, backup, restore }, step),
        '验证步骤无效。',
        400,
      );
      return action(id);
    },
    async result(id) {
      return (await getRecord(id)).record;
    },
    async image(id) {
      const { k, record } = await getRecord(id);
      const image = await read(k.root + '/' + record.imageLocation + '.json');
      requireResult(image, '测试图片不存在。', 404);
      return image;
    },
  };
}
