// Isolated proof renderer. It never imports private drafts or the source blog.
import fs from 'node:fs/promises';
import path from 'node:path';
import { PUBLIC_ORIGIN, PUBLIC_ROOT, SNAPSHOT_LIMIT, articlePath, assetPath, normalizeRelease } from './publication-model.js';

const escape = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const page = (title, content) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escape(title)} · 测试发布</title><style>body{margin:0;background:#f5f1e9;color:#20334b;font:17px/1.8 system-ui,sans-serif}main{max-width:760px;margin:0 auto;padding:36px 22px}a{color:#275e88}h1{line-height:1.4}img{max-width:100%;height:auto;border-radius:8px}p{white-space:pre-wrap;overflow-wrap:anywhere}.tag{display:inline-block;background:#e3e8e8;padding:0 9px;margin:0 8px 8px 0;border-radius:6px}article{padding:16px 0;border-bottom:1px solid #cad1d5}small{color:#526477}</style></head><body><main><a href="${PUBLIC_ROOT}/">测试文章</a><p><small>独立发布验证 · 仅合成测试内容</small></p>${content}</main></body></html>`;

function bodyHtml(article, assets) {
  const permitted = new Set(assets.filter(asset => article.assetHashes.includes(asset.hash)).map(assetPath));
  return article.body.split('\n').map(line => {
    const image = line.match(/^!\[([^\]\n]*)\]\(([^)]+)\)$/);
    if (image && permitted.has(image[2])) return `<p><img src="${image[2]}" alt="${escape(image[1])}" loading="lazy"></p>`;
    const heading = line.match(/^(#{1,3}) (.*)$/);
    return heading ? `<h${heading[1].length + 1}>${escape(heading[2])}</h${heading[1].length + 1}>` : `<p>${escape(line)}</p>`;
  }).join('\n');
}

export async function fetchPublication(fetchImpl = fetch) {
  const response = await fetchImpl(PUBLIC_ORIGIN + '/api/author/public-snapshot', { redirect: 'error', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error('Public snapshot fetch failed: HTTP ' + response.status);
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > SNAPSHOT_LIMIT) { await reader.cancel(); throw Error('Public snapshot exceeds 4 MiB'); }
    chunks.push(value);
  }
  return normalizeRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

export async function buildPublication(input, output) {
  const release = normalizeRelease(input);
  async function write(urlPath, data) {
    const destination = path.join(output, urlPath.slice(1));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, data, { flag: 'wx' });
  }
  const links = release.articles.map(article => `<article><h2><a href="${articlePath(article.slug)}">${escape(article.title)}</a></h2>${article.tags.map(tag => `<span class="tag">${escape(tag)}</span>`).join('')}</article>`).join('\n');
  await write(PUBLIC_ROOT + '/index.html', page('测试文章', '<h1>测试文章</h1>' + (links || '<p>当前没有公开测试文章。私有草稿不在此处展示。</p>')));
  for (const article of release.articles) {
    await write(articlePath(article.slug) + 'index.html', page(article.title, `<h1>${escape(article.title)}</h1><p>${article.tags.map(tag => `<span class="tag">${escape(tag)}</span>`).join('')}</p>` + bodyHtml(article, release.assets)));
  }
  for (const asset of release.assets) await write(assetPath(asset), Buffer.from(asset.data, 'base64'));
  const entries = release.articles.map(article => `<item><title>${escape(article.title)}</title><link>${PUBLIC_ORIGIN + articlePath(article.slug)}</link><guid>${PUBLIC_ORIGIN + articlePath(article.slug)}</guid><pubDate>${new Date(article.publishedAt).toUTCString()}</pubDate><description>${escape(article.body)}</description></item>`).join('');
  await write(PUBLIC_ROOT + '/rss.xml', `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>独立测试文章</title><link>${PUBLIC_ORIGIN + PUBLIC_ROOT}/</link><description>仅明确发布的合成测试内容</description>${entries}</channel></rss>`);
  const marker = { schema: 1, releaseId: release.releaseId, slugs: release.articles.map(article => article.slug), articleCount: release.articles.length, builtAt: new Date().toISOString() };
  await write('/__publication_probe.json', JSON.stringify(marker, null, 2));
  return marker;
}
