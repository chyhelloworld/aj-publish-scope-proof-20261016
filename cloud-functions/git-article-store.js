// Test-environment article adapter. Text lives only in the approved private Git repository.
import { parseDocument, Document } from 'yaml';
import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { openPrivateGit, GitProbeError } from './private-git-client.js';

const text = z.string().trim().min(1);
const slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '网址使用小写字母、数字与连字符');
const day = z
  .union([z.iso.date(), z.iso.datetime({ offset: true }), z.date()])
  .transform((value) => new Date(value).toISOString().slice(0, 10));
const optional = (schema) =>
  z.preprocess(
    (value) => (value === '' || value === null ? undefined : value),
    schema.optional(),
  );
const contract = z
  .object({
    title: text,
    slug,
    description: text,
    date: day,
    tags: z.array(text).default([]),
    draft: z.boolean(),
    sample: z.boolean().default(false),
    series: optional(text),
    seriesOrder: optional(z.number().int().positive()),
    product: optional(slug),
    updatedDate: optional(day),
    updateNote: optional(z.string().trim()),
  })
  .superRefine((value, context) => {
    if (Boolean(value.series) !== (value.seriesOrder !== undefined))
      context.addIssue({ code: 'custom', message: '系列与顺序必须同时填写' });
    if (value.updatedDate && value.updatedDate < value.date)
      context.addIssue({ code: 'custom', message: '修订日期不能早于文章日期' });
  });
const editable = new Set([
  'title',
  'slug',
  'description',
  'date',
  'tags',
  'draft',
  'sample',
  'series',
  'seriesOrder',
  'product',
  'updatedDate',
  'updateNote',
]);
const fail = (message, status = 400) => {
  throw new GitProbeError(message, status);
};
function validate(metadata) {
  const result = contract.safeParse(metadata);
  if (!result.success)
    fail(
      '请检查文章信息：' +
        result.error.issues
          .map((issue) =>
            [issue.path.join('.'), issue.message].filter(Boolean).join(' '),
          )
          .join('；'),
    );
  return { ...result.data, tags: [...new Set(result.data.tags)] };
}
export function parseArticle(raw) {
  const match = raw.match(
    /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/,
  );
  if (!match) fail('文章缺少有效的 YAML 配置。');
  const document = parseDocument(match[1]);
  if (document.errors.length) fail('文章配置无法解析，请先修正源文件。');
  const original = document.toJSON();
  const normalized = validate(original);
  return {
    document,
    metadata: { ...original, ...normalized },
    body: match[2].replace(/^\r?\n/, ''),
  };
}
export function serializeArticle(previous, input) {
  if (!input || typeof input.body !== 'string' || input.body.length > 2_000_000)
    fail('正文格式无效或过长。');
  if (
    !input.metadata ||
    typeof input.metadata !== 'object' ||
    Array.isArray(input.metadata)
  )
    fail('文章信息无效。');
  const old = previous ? parseArticle(previous) : null;
  for (const key of Object.keys(input.metadata))
    if (
      !editable.has(key) &&
      (!old || !isDeepStrictEqual(old.metadata[key], input.metadata[key]))
    )
      fail('请保留未编辑的扩展字段。');
  if (
    old &&
    input.metadata.slug !== undefined &&
    input.metadata.slug !== old.metadata.slug
  )
    fail('已有文章的网址保持不变。');
  if (
    input.metadata.draft !== undefined &&
    input.metadata.draft !== (old?.metadata.draft ?? true)
  )
    fail('保存草稿不能改变发表状态。');
  const metadata = validate({
    ...old?.metadata,
    ...input.metadata,
    draft: old?.metadata.draft ?? true,
  });
  const document = old?.document || new Document();
  for (const key of editable) {
    if (metadata[key] === undefined) document.delete(key);
    else document.set(key, metadata[key]);
  }
  if (!old) document.set('articleId', metadata.slug);
  return `---\n${document.toString({ lineWidth: 0 })}---\n\n${input.body}`;
}
const fileFor = (id) => {
  if (!slug.safeParse(id).success) fail('文章标识无效。');
  return `articles/${id}.md`;
};
function record(id, stored) {
  if (!stored) fail('文章不存在。', 404);
  const { metadata, body } = parseArticle(stored.raw);
  if (metadata.slug !== id) fail('文件名与文章网址不一致，请先核对源文件。');
  return { id, revision: stored.sha, metadata, body };
}
export function createGitArticleStore({ env, fetchImpl = fetch, openGit }) {
  const connect = () =>
    openGit ? openGit() : openPrivateGit({ env, fetchImpl });
  return {
    async list() {
      const git = await connect(),
        files = await git.listArticles(),
        items = [];
      for (let start = 0; start < files.length; start += 4) {
        items.push(
          ...(await Promise.all(
            files.slice(start, start + 4).map(async (file) => {
              const id = file.slice('articles/'.length, -3);
              const item = record(id, await git.read(file));
              return {
                id,
                revision: item.revision,
                ...Object.fromEntries(
                  ['title', 'date', 'description', 'tags'].map((key) => [
                    key,
                    item.metadata[key],
                  ]),
                ),
              };
            }),
          )),
        );
      }
      return {
        items: items.sort(
          (a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id),
        ),
      };
    },
    async read(id) {
      const file = fileFor(id),
        git = await connect();
      return record(id, await git.read(file));
    },
    async save(input) {
      const id = input?.id || input?.metadata?.slug,
        file = fileFor(id),
        git = await connect();
      let old = null;
      if (input.revision) {
        if (!/^[a-f0-9]{40}$/.test(input.revision)) fail('版本标识无效。');
        old = await git.read(file);
        if (!old || old.sha !== input.revision)
          fail('文章已有新版本，当前输入已保留。请先核对云端。', 409);
      }
      const raw = serializeArticle(old?.raw, input);
      if (parseArticle(raw).metadata.slug !== id)
        fail('已有文章的网址保持不变。');
      const result = await git.write(file, raw, input.revision);
      if ([409, 422].includes(result.status))
        fail('这个网址已存在或文章已有更新，当前输入已保留。', 409);
      if (![200, 201].includes(result.status))
        fail('保存结果尚未确认，请保留当前输入并检查云端。', 503);
      return {
        ...record(id, { raw, sha: result.sha }),
        savedAt: new Date().toISOString(),
      };
    },
  };
}
