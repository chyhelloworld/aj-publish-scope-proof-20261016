import { saveRecovery, readRecovery, clearRecovery, sessionExpired } from './session.js';

const $ = id => document.getElementById(id);
let current = { title: '', body: '', tags: [] };
let authenticated = false;
let everAuthenticated = false;
let busy = false;
let expiresAt = null;
let expiryTimer;
let publicationTimer;
let publication = null;
let publicationConfigured = false;
let storage;
try { storage = window.sessionStorage; } catch { storage = null; }

function notify(text, error = false) {
  $('notice').textContent = text;
  $('notice').className = 'notice' + (error ? ' error' : '');
}
function editorRecord() {
  return { id: current.id, revision: current.revision, title: $('title').value, body: $('body').value, tags: [...new Set($('tags').value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))] };
}
function sameContent(left, right) {
  return left.title === right.title && left.body === right.body && JSON.stringify(left.tags || []) === JSON.stringify(right.tags || []);
}
const dirty = () => !sameContent(editorRecord(), current);
function controls() {
  $('editor').disabled = !everAuthenticated;
  for (const id of ['save', 'image', 'new-draft']) $(id).disabled = !authenticated || busy;
  const building = publication?.phase === 'building';
  $('publish').disabled = !authenticated || busy || building || !publicationConfigured || !current.id || dirty();
  $('withdraw').disabled = !authenticated || busy || building || !publicationConfigured || dirty() || !publication?.published.some(item => item.draftId === current.id);
  $('retry-build').disabled = !authenticated || busy;
}
function expireSession() {
  authenticated = false;
  clearTimeout(expiryTimer);
  clearTimeout(publicationTimer);
  $('account').textContent = '登录已过期';
  $('login-detail').textContent = '当前文字仍保留在页面。重新登录后可继续保存；跳转前会暂存本页文字。';
  $('login').hidden = false;
  $('login').textContent = '重新使用 GitHub 登录 ↗';
  $('login').setAttribute('aria-disabled', 'false');
  $('logout').hidden = true;
  controls();
}
function showError(error) {
  if (error.status === 401) { notify('登录已过期，当前文字未清空。请使用上方入口重新登录。', true); return; }
  notify(error.message || '请求没有完成，请稍后重试。', true);
}
async function api(path, options = {}) {
  const response = await fetch('/api/author' + path, {
    credentials: 'same-origin', ...options,
    headers: { 'X-Author-Probe': '1', ...(options.body instanceof File ? {} : { 'Content-Type': 'application/json' }), ...options.headers }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && everAuthenticated) expireSession();
    const error = new Error(data.error || '请求没有完成，请稍后重试。');
    error.status = response.status;
    throw error;
  }
  return data;
}
function setEditor(record = { title: '', body: '', tags: [] }) {
  current = record;
  $('title').value = record.title || '';
  $('tags').value = (record.tags || []).join('，');
  $('body').value = record.body || '';
  $('save-state').textContent = record.updatedAt ? '已保存 ' + new Date(record.updatedAt).toLocaleTimeString() : '新草稿';
  $('preview').hidden = true;
  renderPublication();
  controls();
}
function renderPreview() {
  const target = $('preview-content');
  target.replaceChildren();
  for (const line of $('body').value.split('\n')) {
    const image = line.match(/^!\[[^\]]*\]\((\/api\/author\/images\/[a-f0-9-]{36})\)$/);
    const element = document.createElement(image ? 'img' : 'p');
    if (image) { element.src = image[1]; element.alt = '已上传的测试图片'; }
    else element.textContent = line;
    target.append(element);
  }
}
function discardAllowed() {
  return !dirty() || confirm('当前文字尚未保存，确定放弃这些修改吗？');
}
async function refreshList() {
  const { items } = await api('/drafts');
  const list = $('draft-list');
  list.replaceChildren();
  if (!items.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '还没有测试草稿。'; list.append(p); return; }
  for (const item of items) {
    const button = document.createElement('button');
    button.className = 'draft-item' + (current.id === item.id ? ' active' : '');
    const title = document.createElement('strong');
    const time = document.createElement('small');
    title.textContent = item.title;
    time.textContent = new Date(item.updatedAt).toLocaleString();
    button.append(title, time);
    button.onclick = async () => {
      if (!discardAllowed()) return;
      try { setEditor(await api('/drafts/' + item.id)); clearRecovery(storage); notify('已从云端重新打开草稿。'); await refreshList(); }
      catch (error) { showError(error); }
    };
    list.append(button);
  }
}
function renderPublication() {
  const labels = {
    unconfigured: '测试发布入口已准备，等待配置项目部署钩子。',
    idle: '保存只更新私有草稿。点击发布后才会生成公开测试快照。',
    building: '已提交构建，正在等待测试站实际上线。',
    unconfirmed: '暂未确认上线，请稍后检查或重试构建。',
    'trigger-failed': publication?.operation?.triggerError || '构建触发未完成，请重试。',
    live: publication?.operation?.action === 'withdraw' ? '撤回版本已在测试站生效。' : '发布版本已在测试站生效。'
  };
  const binding = publication?.published.find(item => item.draftId === current.id);
  $('publication-state').textContent = labels[publication?.phase || (publicationConfigured ? 'idle' : 'unconfigured')];
  $('publication-detail').textContent = binding
    ? (binding.sourceRevision === current.revision ? '本篇已选入测试发布快照。' : '本篇草稿有后续修改，尚未重新发布。')
    : '本篇尚未选入公开测试快照。';
  $('published-link').hidden = !binding;
  if (binding) $('published-link').href = binding.url;
  $('retry-build').hidden = !['trigger-failed', 'unconfirmed'].includes(publication?.phase);
  controls();
}
async function refreshPublication() {
  clearTimeout(publicationTimer);
  if (!authenticated) return;
  try {
    publication = await api('/publication-status');
    publicationConfigured = publication.configured;
    renderPublication();
    if (['building', 'unconfirmed', 'trigger-failed'].includes(publication.phase) && document.visibilityState !== 'hidden') {
      publicationTimer = setTimeout(refreshPublication, publication.phase === 'building' ? 5000 : 15000);
    }
  } catch (error) { showError(error); }
}
async function initialize() {
  try {
    const status = await api('/status');
    publicationConfigured = status.publicationConfigured;
    if (!status.authConfigured || !status.storageReady) {
      $('account').textContent = '测试服务尚未就绪';
      $('login-detail').textContent = '请稍后刷新；当前没有清空已输入文字。';
      return;
    }
    $('login').setAttribute('aria-disabled', 'false');
    let me;
    try { me = await api('/me'); }
    catch (error) {
      if (error.status !== 401) throw error;
      $('account').textContent = '用 GitHub 开始写作';
      $('login-detail').textContent = '只读取公开身份信息，不申请仓库读写权限。';
      renderPublication();
      return;
    }
    authenticated = true;
    everAuthenticated = true;
    expiresAt = me.expiresAt;
    $('account').textContent = '已登录 · ' + me.login;
    $('login-detail').textContent = '保存为私有草稿；发布和撤回只影响独立测试站。';
    $('login').hidden = true;
    $('logout').hidden = false;
    expiryTimer = setTimeout(expireSession, Math.max(0, expiresAt - Date.now()));
    const recovery = readRecovery(storage);
    if (recovery) {
      current = recovery.base;
      $('title').value = recovery.editor.title;
      $('body').value = recovery.editor.body;
      $('tags').value = recovery.editor.tags.join('，');
      $('save-state').textContent = dirty() ? '已恢复未保存文字' : '已恢复草稿';
      notify('已恢复登录前的文字。请核对后保存；不会自动发布。');
    }
    controls();
    await refreshList();
    await refreshPublication();
  } catch (error) { $('account').textContent = '测试服务暂时不可用'; showError(error); }
}
$('login').onclick = event => {
  if ($('login').getAttribute('aria-disabled') === 'true') { event.preventDefault(); return; }
  const editor = editorRecord();
  if (everAuthenticated && (editor.title || editor.body || current.id)) {
    const base = { id: current.id, revision: current.revision, title: current.title || '', body: current.body || '', tags: current.tags || [], updatedAt: current.updatedAt };
    if (!saveRecovery(storage, { base, editor })) {
      event.preventDefault();
      notify('浏览器未能暂存文字。请先复制正文，再在新标签页打开登录链接。', true);
    }
  }
};
$('new-draft').onclick = () => {
  if (!discardAllowed()) return;
  clearRecovery(storage);
  setEditor();
  notify('新草稿不会自动发表。');
};
$('save').onclick = async () => {
  if (!authenticated || busy) return;
  busy = true; controls(); $('save-state').textContent = '正在保存…';
  const submitted = editorRecord();
  try {
    const saved = await api('/drafts', { method: 'POST', body: JSON.stringify(submitted) });
    if (sameContent(editorRecord(), submitted)) {
      setEditor(saved); clearRecovery(storage); notify('草稿已保存，尚未改变测试站上的公开版本。');
    } else {
      current = saved; $('save-state').textContent = '有未保存修改';
      notify('已保存提交时的版本；你刚输入的新文字仍在页面，请再次保存。');
    }
    await refreshList(); await refreshPublication();
  } catch (error) { $('save-state').textContent = '尚未保存'; showError(error); }
  finally { busy = false; controls(); }
};
$('image').onchange = async () => {
  const file = $('image').files[0];
  if (!file || !authenticated || busy) return;
  if (file.size > 2 * 1024 * 1024) { notify('测试图片上限为 2 MiB。', true); $('image').value = ''; return; }
  busy = true; controls(); notify('正在上传测试图片…');
  try {
    const image = await api('/images', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    $('body').value += '\n\n![测试图片](' + image.url + ')\n';
    $('save-state').textContent = '有未保存修改';
    notify('图片已私有保存，请保存草稿以保留引用。');
  } catch (error) { showError(error); }
  finally { busy = false; $('image').value = ''; controls(); }
};
async function publishAction(action) {
  if (!authenticated || busy) return;
  if (action !== 'retry' && dirty()) { notify('请先保存当前修改，再发布或撤回。', true); return; }
  busy = true; controls();
  try {
    const response = await api('/publication', { method: 'POST', body: JSON.stringify({ action, draftId: current.id, revision: current.revision }) });
    notify(response.accepted ? '构建请求已接受；请等待测试站实际版本确认。' : response.operation.triggerError, !response.accepted);
    await refreshPublication();
  } catch (error) { showError(error); }
  finally { busy = false; controls(); }
}
$('publish').onclick = () => publishAction('publish');
$('withdraw').onclick = () => publishAction('withdraw');
$('retry-build').onclick = () => publishAction('retry');
$('check-publication').onclick = refreshPublication;
$('preview-toggle').onclick = () => { renderPreview(); $('preview').hidden = !$('preview').hidden; };
$('logout').onclick = async () => {
  if (!discardAllowed()) return;
  try {
    const response = await fetch('/api/author/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-Author-Probe': '1', 'Content-Type': 'application/json' }, body: '{}' });
    if (!response.ok && response.status !== 401) throw Error('退出未完成，请重试。');
    clearRecovery(storage); location.replace('/author-probe/');
  } catch (error) { showError(error); }
};
for (const id of ['title', 'tags', 'body']) $(id).addEventListener('input', () => { $('save-state').textContent = '有未保存修改'; controls(); });
document.addEventListener('visibilitychange', () => {
  if (authenticated && sessionExpired(expiresAt)) expireSession();
  if (document.visibilityState === 'hidden') clearTimeout(publicationTimer);
  else if (authenticated) refreshPublication();
});
window.addEventListener('pageshow', () => { if (authenticated && sessionExpired(expiresAt)) expireSession(); });
initialize();
