import { createHash } from 'node:crypto';

export const PUBLIC_ORIGIN = 'https://writer-test.aj.new.tg';
export const PUBLIC_ROOT = '/publication-proof';
export const SNAPSHOT_LIMIT = 4 * 1024 * 1024;
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const assetPath = asset => PUBLIC_ROOT + '/assets/' + asset.hash + '.' + TYPES[asset.mime];
export const articlePath = slug => PUBLIC_ROOT + '/articles/' + slug + '/';
export const emptyRelease = () => ({ schema: 1, releaseId: 'bootstrap', createdAt: null, articles: [], assets: [] });

export function normalizeRelease(input) {
  const bad = () => { throw new Error('Invalid publication snapshot'); };
  if (!input || input.schema !== 1 || !/^(bootstrap|[a-f0-9-]{36})$/.test(input.releaseId)) bad();
  if (input.releaseId === 'bootstrap' ? input.createdAt !== null : typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) bad();
  if (!Array.isArray(input.articles) || input.articles.length > 20 || !Array.isArray(input.assets)) bad();
  const assets = input.assets.map(asset => {
    if (!/^[a-f0-9]{64}$/.test(asset.hash) || !TYPES[asset.mime] || typeof asset.data !== 'string') bad();
    const bytes = Buffer.from(asset.data, 'base64');
    if (!bytes.length || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== asset.data) bad();
    if (createHash('sha256').update(bytes).digest('hex') !== asset.hash) bad();
    return { hash: asset.hash, mime: asset.mime, data: asset.data };
  });
  const hashes = new Set(assets.map(asset => asset.hash));
  if (hashes.size !== assets.length) bad();
  const articles = input.articles.map(article => {
    if (!/^probe-[a-f0-9-]{36}$/.test(article.slug)) bad();
    if (typeof article.title !== 'string' || !article.title.trim() || article.title.length > 120) bad();
    if (typeof article.body !== 'string' || article.body.length > 120000 || article.body.includes('/api/author/')) bad();
    if (!Array.isArray(article.tags) || article.tags.length > 8 || article.tags.some(tag => typeof tag !== 'string' || tag.length > 30)) bad();
    if (!Array.isArray(article.assetHashes) || article.assetHashes.some(hash => !hashes.has(hash))) bad();
    if (typeof article.publishedAt !== 'string' || !Number.isFinite(Date.parse(article.publishedAt))) bad();
    return { slug: article.slug, title: article.title, body: article.body, tags: [...article.tags], publishedAt: article.publishedAt, assetHashes: [...article.assetHashes] };
  });
  if (new Set(articles.map(article => article.slug)).size !== articles.length) bad();
  const used = new Set(articles.flatMap(article => article.assetHashes));
  if (assets.some(asset => !used.has(asset.hash))) bad();
  const release = { schema: 1, releaseId: input.releaseId, createdAt: input.createdAt, articles, assets };
  if (Buffer.byteLength(JSON.stringify(release)) > SNAPSHOT_LIMIT) bad();
  return release;
}
