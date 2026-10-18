import { Editor, generateHTML } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import DOMPurify from 'dompurify';
import {
  sameArticle,
  saveResolution,
  storeRecovery,
  loadRecovery,
  clearRecovery,
} from './model.js';
import { prepareImage, observePreviewImages } from './images.js';
import { preservesMarkdown } from './markdown-safety.js';

const $ = (id) => document.getElementById(id);
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const blank = () => ({
  id: '',
  metadata: {
    title: '',
    slug: `note-${today().replaceAll('-', '')}-${crypto.randomUUID().slice(0, 8)}`,
    description: '',
    date: today(),
    tags: [],
    draft: true,
    sample: true,
  },
  body: '',
});
let base = blank(),
  body = '',
  authenticated = false,
  everAuthenticated = false,
  busy = false,
  locked = false,
  pending = null,
  remote = null,
  sourceMode = false,
  loading = false,
  expiryTimer,
  navigating = false;
let storage;
try {
  storage = sessionStorage;
} catch {
  storage = null;
}
const extensions = () => [
  StarterKit.configure({ underline: false, link: { openOnClick: false } }),
  TableKit,
  Image,
  Markdown,
];
const createEditor = (content = '') => new Editor({
  element: $('rich'),
  editable: false,
  extensions: extensions(),
  content,
  contentType: 'markdown',
  editorProps: {
    attributes: {
      class: 'prose',
      role: 'textbox',
      'aria-label': '文章正文',
      'aria-multiline': 'true',
    },
  },
  onUpdate: ({ editor }) => {
    if (!loading) {
      body = editor.getMarkdown();
      changed();
    }
  },
});
let editor = createEditor();

function notify(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = 'notice' + (error ? ' error' : '');
}
function snapshot() {
  return {
    id: base.id || $('slug').value.trim(),
    revision: base.revision,
    metadata: {
      ...base.metadata,
      title: $('title').value,
      slug: $('slug').value.trim(),
      description: $('description').value,
      date: $('date').value,
      tags: [
        ...new Set(
          $('tags')
            .value.split(/[,，]/)
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ],
      sample: $('sample').checked,
      series: $('series').value || null,
      seriesOrder: $('seriesOrder').value
        ? Number($('seriesOrder').value)
        : null,
      product: $('product').value || null,
      updatedDate: $('updatedDate').value || null,
      updateNote: $('updateNote').value || null,
    },
    body,
  };
}
const dirty = () =>
  !sameArticle({ ...base, id: base.id || base.metadata.slug }, snapshot());
function controls() {
  $('fields').disabled = !everAuthenticated;
  if (editor.isEditable !== everAuthenticated)
    editor.setEditable(everAuthenticated, false);
  for (const id of ['new', 'image']) $(id).disabled = !authenticated || busy;
  $('save').disabled = !authenticated || busy || Boolean(pending);
  $('preview-toggle').disabled = !everAuthenticated;
  $('slug').disabled = locked || Boolean(base.revision);
  $('check-remote').hidden = !pending;
  $('check-remote').disabled = !authenticated || busy;
  $('logout').disabled = busy;
  for (const button of $('draft-list').querySelectorAll('button')) {
    button.disabled = busy || !authenticated;
    button.classList.toggle('active', button.dataset.id === base.id);
  }
}
function changed() {
  if (!loading) {
    $('save-state').textContent = pending
      ? '保存结果待核对'
      : dirty()
        ? '有未保存修改'
        : base.revision
          ? '已保存'
          : '新草稿';
    controls();
  }
}
function replaceBody(value, resetHistory = false) {
  const changedBody = body !== value;
  body = value;
  loading = true;
  if (resetHistory) {
    editor.destroy();
    editor = createEditor(value);
  } else if (changedBody || sourceMode) {
    editor.commands.setContent(value, {
      contentType: 'markdown',
      emitUpdate: false,
    });
  }
  $('source').value = value;
  const supported = preservesMarkdown(editor.markdown, value, editor.getMarkdown());
  $('editor-hint').hidden = supported;
  if (!supported) showMode(true);
  loading = false;
}
function fill(record, { resetHistory = true } = {}) {
  base = record;
  loading = true;
  for (const name of [
    'title',
    'slug',
    'description',
    'date',
    'series',
    'seriesOrder',
    'product',
    'updatedDate',
    'updateNote',
  ])
    $(name).value = record.metadata[name] ?? '';
  $('tags').value = (record.metadata.tags || []).join('，');
  $('sample').checked = Boolean(record.metadata.sample);
  replaceBody(record.body, resetHistory);
  loading = false;
  locked = Boolean(record.revision);
  pending = null;
  remote = null;
  $('preview').hidden = true;
  $('remote-panel').hidden = true;
  $('save-state').textContent = record.revision ? '已从私有仓库读取' : '新草稿';
  controls();
}
function expire() {
  authenticated = false;
  clearTimeout(expiryTimer);
  $('account').textContent = '登录已过期';
  $('login-detail').textContent = '当前输入仍在页面。重新登录后可继续保存。';
  $('login').hidden = false;
  $('login').textContent = '重新登录 ↗';
  $('logout').hidden = true;
  controls();
}
async function api(route, { method = 'GET', data, file } = {}) {
  let response;
  try {
    response = await fetch('/api/author' + route, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(45000),
      headers: {
        'X-Author-Probe': '1',
        ...(file
          ? { 'Content-Type': file.type }
          : { 'Content-Type': 'application/json' }),
      },
      ...(file ? { body: file } : data ? { body: JSON.stringify(data) } : {}),
    });
  } catch {
    throw new Error(
      method === 'GET'
        ? '暂时无法读取云端，请稍后重试。'
        : '请求中断，保存结果待确认；当前输入已保留。',
    );
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.error || '请求未完成，请保留当前内容。');
    error.status = response.status;
    if (response.status === 401) expire();
    throw error;
  }
  if (!result) throw Error('返回内容不完整，请检查云端结果。');
  return result;
}
const discard = () =>
  !(dirty() || pending) ||
  confirm('当前有未保存或待确认的内容。确定离开这篇文章吗？');
async function refreshList() {
  const { items } = await api('/git-articles');
  const list = $('draft-list');
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有 Git 草稿。新建一篇开始写作。';
    list.append(empty);
    return;
  }
  for (const item of items) {
    const button = document.createElement('button');
    button.dataset.id = item.id;
    button.className = 'draft-item' + (base.id === item.id ? ' active' : '');
    const title = document.createElement('strong'),
      date = document.createElement('small');
    title.textContent = item.title;
    date.textContent = item.date;
    button.append(title, date);
    button.disabled = busy;
    button.onclick = async () => {
      if (busy || !discard()) return;
      busy = true;
      controls();
      try {
        fill(await api('/git-articles/' + item.id));
        clearRecovery(storage);
        notify('已重新打开云端草稿。');
      } catch (error) {
        notify(error.message, true);
      } finally {
        busy = false;
        controls();
      }
    };
    list.append(button);
  }
}
function acceptSave(saved, submitted) {
  const current = snapshot();
  pending = null;
  if (sameArticle(current, submitted)) {
    fill(saved, { resetHistory: false });
    clearRecovery(storage);
    $('save-state').textContent = '已保存';
    notify('草稿已保存，公开站点没有变化。');
  } else {
    base = saved;
    locked = true;
    $('save-state').textContent = '有未保存修改';
    notify('提交时的内容已保存，刚输入的新文字仍在本页。');
  }
  $('remote-panel').hidden = true;
  controls();
}
async function save() {
  if (!authenticated || busy || pending) return;
  if (!$('title').value.trim()) {
    notify('请先填写标题。', true);
    $('title').focus();
    return;
  }
  if (!$('description').value.trim())
    $('description').value =
      (sourceMode ? body.replace(/[#*`>\[\]]/g, ' ') : editor.getText())
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || $('title').value.trim();
  const submitted = snapshot();
  busy = true;
  locked = true;
  pending = submitted;
  $('save-state').textContent = '正在保存…';
  controls();
  try {
    const saved = await api('/git-articles', {
      method: 'POST',
      data: submitted,
    });
    if (!saved.metadata || !saved.revision)
      throw Error('保存回执不完整，请检查云端。');
    acceptSave(saved, submitted);
    try {
      await refreshList();
    } catch {
      notify('草稿已保存，列表暂时未刷新。');
    }
  } catch (error) {
    if (error.status && error.status < 500 && error.status !== 409) {
      pending = null;
      locked = Boolean(base.revision);
      $('save-state').textContent = '尚未保存';
    } else {
      $('save-state').textContent =
        error.status === 409 ? '版本冲突，输入已保留' : '保存结果待确认';
    }
    notify(error.message, true);
  } finally {
    busy = false;
    controls();
  }
}
async function checkRemote() {
  if (!pending || !authenticated || busy) return;
  busy = true;
  controls();
  try {
    const found = await api('/git-articles/' + pending.id);
    const decision = saveResolution(found, pending, snapshot());
    if (decision !== 'conflict') acceptSave(found, pending);
    else {
      remote = found;
      $('remote-panel').hidden = false;
      $('remote-note').textContent =
        '云端内容与本页不同。当前输入仍保留；请先复制需要的内容，再采用云端版本后合并。';
      $('remote-content').textContent =
        JSON.stringify(found.metadata, null, 2) + '\n\n' + found.body;
      notify('存在另一份云端版本，尚未覆盖本页输入。', true);
    }
  } catch (error) {
    if (error.status === 404) {
      pending = null;
      locked = Boolean(base.revision);
      notify('当前未查到该稿，可用同一网址再次保存；不会另建重复文章。');
    } else notify(error.message, true);
  } finally {
    busy = false;
    controls();
  }
}
function preview() {
  $('preview-title').textContent = $('title').value;
  if (preservesMarkdown(editor.markdown, body)) {
    const html = generateHTML(editor.markdown.parse(body), extensions());
    $('preview-content').innerHTML = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
    });
  } else {
    const note = document.createElement('p');
    note.textContent = '此文含暂不支持的排版格式，以下显示 Markdown 原文。';
    const source = document.createElement('pre');
    source.textContent = body;
    $('preview-content').replaceChildren(note, source);
  }
  for (const link of $('preview-content').querySelectorAll('a')) {
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
  }
  observePreviewImages($('preview-content'), {
    checkSession: () => api('/me'),
    onExpired: expire,
  });
  $('preview').hidden = false;
}
async function upload() {
  const file = $('image').files[0];
  if (!file || busy || !authenticated) return;
  busy = true;
  controls();
  $('image-state').textContent = '正在准备图片…';
  try {
    const prepared = await prepareImage(file);
    $('image-state').textContent = prepared.changed
      ? `图片已缩小到 ${(prepared.file.size / 1024 / 1024).toFixed(2)} MiB，正在上传…`
      : '正在上传图片…';
    const image = await api('/images', { method: 'POST', file: prepared.file });
    if (sourceMode) {
      body = $('source').value + '\n\n![文章配图](' + image.url + ')\n';
      $('source').value = body;
    } else
      editor
        .chain()
        .focus()
        .setImage({ src: image.url, alt: '文章配图' })
        .run();
    $('image-state').textContent = prepared.changed
      ? `图片已私有保存：${(prepared.originalBytes / 1024 / 1024).toFixed(2)} → ${(prepared.file.size / 1024 / 1024).toFixed(2)} MiB，${prepared.width} × ${prepared.height}。请保存草稿。`
      : '图片已私有保存。请保存草稿以保留图片引用。';
    changed();
  } catch (error) {
    $('image-state').textContent = error.message;
    notify('图片没有完成上传，当前正文未清空。', true);
  } finally {
    $('image').value = '';
    busy = false;
    controls();
  }
}
function switchMode(source) {
  if (source === sourceMode) return;
  if (source) $('source').value = body;
  else {
    loading = true;
    // Source edits start a new rich-text history; hidden lossy parses must never be undoable.
    editor.destroy();
    editor = createEditor(body);
    loading = false;
    controls();
    if (!preservesMarkdown(editor.markdown, body, editor.getMarkdown())) {
      $('editor-hint').hidden = false;
      notify('这篇文章含排版编辑暂不支持的格式，已保留 Markdown 原文。');
      return;
    }
    $('editor-hint').hidden = true;
  }
  showMode(source);
}
function showMode(source) {
  sourceMode = source;
  $('source').hidden = !source;
  $('rich').hidden = source;
  $('toolbar').hidden = source;
  $('rich-tab').setAttribute('aria-pressed', String(!source));
  $('source-tab').setAttribute('aria-pressed', String(source));
}
const commands = {
  bold: () => editor.chain().focus().toggleBold().run(),
  italic: () => editor.chain().focus().toggleItalic().run(),
  heading: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  bulletList: () => editor.chain().focus().toggleBulletList().run(),
  orderedList: () => editor.chain().focus().toggleOrderedList().run(),
  blockquote: () => editor.chain().focus().toggleBlockquote().run(),
  codeBlock: () => editor.chain().focus().toggleCodeBlock().run(),
  table: () =>
    editor
      .chain()
      .focus()
      .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
      .run(),
  undo: () => editor.chain().focus().undo().run(),
  redo: () => editor.chain().focus().redo().run(),
};
for (const button of $('toolbar').querySelectorAll('button'))
  button.onclick = () => commands[button.dataset.command]();
$('rich-tab').onclick = () => switchMode(false);
$('source-tab').onclick = () => switchMode(true);
$('source').oninput = () => {
  body = $('source').value;
  changed();
};
$('save').onclick = save;
$('check-remote').onclick = checkRemote;
$('preview-toggle').onclick = () => {
  if ($('preview').hidden) preview();
  else $('preview').hidden = true;
};
$('image').onchange = upload;
$('new').onclick = () => {
  if (!busy && discard()) {
    clearRecovery(storage);
    fill(blank());
    notify('新稿只保存到私有空间。');
  }
};
$('use-remote').onclick = () => {
  if (
    remote &&
    confirm('采用云端版本会替换本页输入。已复制需要保留的文字吗？')
  ) {
    fill(remote);
    clearRecovery(storage);
    notify('已采用云端版本，可以合并后再次保存。');
  }
};
for (const id of [
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
])
  $(id).addEventListener('input', changed);
$('login').onclick = (event) => {
  if (everAuthenticated) {
    if (
      !storeRecovery(storage, { base, editor: snapshot(), pending, locked })
    ) {
      event.preventDefault();
      notify('浏览器暂存失败。请先复制当前正文，再在新标签页登录。', true);
      return;
    }
  }
  navigating = true;
};
$('logout').onclick = async () => {
  if (busy || !discard()) return;
  try {
    const response = await fetch('/api/author/logout', {
      method: 'POST',
      headers: { 'X-Author-Probe': '1', 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok && response.status !== 401)
      throw Error('退出未完成，请稍后重试。');
    clearRecovery(storage);
    navigating = true;
    location.replace('/git-writer/');
  } catch (error) {
    notify(error.message, true);
  }
};
window.addEventListener('beforeunload', (event) => {
  if (!navigating && everAuthenticated && (dirty() || pending)) {
    event.preventDefault();
    event.returnValue = '';
  }
});
async function initialize() {
  fill(base);
  try {
    const me = await api('/me');
    authenticated = true;
    everAuthenticated = true;
    $('account').textContent = '已登录 · ' + me.login;
    $('login-detail').textContent = '保存到私有空间，预览仅自己可见。';
    $('login').hidden = true;
    $('logout').hidden = false;
    expiryTimer = setTimeout(expire, Math.max(0, me.expiresAt - Date.now()));
    const recovered = loadRecovery(storage);
    if (recovered) {
      fill(recovered.base);
      const current = recovered.editor;
      loading = true;
      for (const name of [
        'title',
        'slug',
        'description',
        'date',
        'series',
        'seriesOrder',
        'product',
        'updatedDate',
        'updateNote',
      ])
        $(name).value = current.metadata[name] ?? '';
      $('tags').value = current.metadata.tags.join('，');
      $('sample').checked = Boolean(current.metadata.sample);
      replaceBody(current.body);
      loading = false;
      pending = recovered.pending || null;
      locked = Boolean(recovered.locked || base.revision);
      changed();
      notify('已恢复登录前的输入，请核对后保存；不会自动发表。');
    }
    controls();
    await refreshList();
  } catch (error) {
    if (error.status === 401) {
      $('account').textContent = '用 GitHub 开始写作';
      $('login-detail').textContent =
        '使用已有身份登录，不向浏览器提供仓库令牌。';
    } else notify(error.message, true);
  }
}
initialize();
