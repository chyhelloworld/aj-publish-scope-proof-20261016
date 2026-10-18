export const fields = [
  'title',
  'slug',
  'description',
  'date',
  'tags',
  'sample',
  'series',
  'seriesOrder',
  'product',
  'updatedDate',
  'updateNote',
  'draft',
];
export function comparable(record) {
  const metadata = record?.metadata || {};
  return JSON.stringify({
    id: record?.id || metadata.slug || '',
    body: record?.body || '',
    metadata: Object.fromEntries(
      fields.map((key) => [
        key,
        key === 'tags'
          ? [
              ...new Set(
                (metadata.tags || []).map((tag) => tag.trim()).filter(Boolean),
              ),
            ]
          : ['sample', 'draft'].includes(key)
            ? Boolean(metadata[key])
            : key === 'seriesOrder'
              ? (metadata[key] ?? '')
              : String(metadata[key] ?? '').trim(),
      ]),
    ),
  });
}
export const sameArticle = (a, b) => comparable(a) === comparable(b);
export function saveResolution(remote, submitted, current) {
  if (!sameArticle(remote, submitted)) return 'conflict';
  return sameArticle(current, submitted) ? 'saved' : 'newer-local';
}
const KEY = 'aj-git-writer-recovery-v1';
export function storeRecovery(storage, value, now = Date.now()) {
  try {
    storage.setItem(KEY, JSON.stringify({ schema: 1, at: now, ...value }));
    return true;
  } catch {
    return false;
  }
}
export function clearRecovery(storage) {
  try {
    storage.removeItem(KEY);
  } catch {}
}
export function loadRecovery(storage, now = Date.now()) {
  try {
    const item = JSON.parse(storage.getItem(KEY) || 'null');
    if (!item) return null;
    if (
      item.schema !== 1 ||
      !Number.isFinite(item.at) ||
      now - item.at > 86400000 ||
      item.at > now + 60000 ||
      typeof item.editor?.body !== 'string' ||
      !item.editor?.metadata ||
      typeof item.base?.body !== 'string'
    )
      throw Error('Invalid recovery');
    return item;
  } catch {
    clearRecovery(storage);
    return null;
  }
}
