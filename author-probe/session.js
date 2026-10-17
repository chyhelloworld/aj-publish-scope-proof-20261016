const KEY = 'aj-author-relogin-v1';
export function clearRecovery(storage) { try { storage.removeItem(KEY); } catch {} }
export function saveRecovery(storage, value, now = Date.now()) {
  try { storage.setItem(KEY, JSON.stringify({ schema: 1, at: now, ...value })); return true; }
  catch { return false; }
}
export function readRecovery(storage, now = Date.now()) {
  try {
    const value = JSON.parse(storage.getItem(KEY) || 'null');
    if (!value) return null;
    if (value.schema !== 1 || !Number.isFinite(value.at) || now - value.at > 86400000 || value.at > now + 60000) throw Error('Expired recovery');
    for (const record of [value.base, value.editor]) {
      if (!record || typeof record.title !== 'string' || typeof record.body !== 'string' || record.body.length > 120000 || !Array.isArray(record.tags)) throw Error('Invalid recovery');
    }
    return value;
  } catch { clearRecovery(storage); return null; }
}
export const sessionExpired = (expiresAt, now = Date.now()) => Number.isFinite(expiresAt) && now >= expiresAt;
