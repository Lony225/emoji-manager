// 公共工具：请求、提示、对话框、剪贴板
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const icons = {
  chevronDown: 'M6 9l6 6 6-6',
  image: 'M4 5h16v14H4zM9 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM4 16l5-5 4 4 2-2 5 5',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm9 16-4-4',
  copy: 'M9 9h11v11H9zM4 15V4h11',
  download: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12 5 5L20 7',
  smile: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM9 10h.01M15 10h.01M8.5 14a4 4 0 0 0 7 0',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 4.5v5M8 14.5v5',
  logout: 'M9 4H5v16h4M14 8l4 4-4 4M18 12H9',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  rocket: 'M5 15l-2 2 4 4 2-2M14 4c3 0 6 3 6 6 0 2-3 5-6 7l-4-4c2-3 4-9 4-9zM9 13l-3 1 4 4 1-3M15 9h.01',
  folder: 'M3 6h6l2 2h10v11H3z',
};

export function icon(name, size = 16) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', icons[name]);
  svg.append(p);
  return svg;
}

// ---------------------------------------------------------------- 请求
export async function api(path, { method = 'GET', body, form } = {}) {
  const init = { method, headers: {}, credentials: 'same-origin' };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) throw new Error(data?.error || (res.status === 413 ? '文件太大，超过了服务器允许的上传大小' : `请求失败（HTTP ${res.status}）`));
  return data;
}

/** 带进度的上传（fetch 拿不到上传进度，用 XMLHttpRequest） */
/** 带进度的上传：onProgress(已传字节, 总字节)；signal 可取消（reject 的错误带 aborted: true） */
export function upload(path, form, onProgress, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.withCredentials = true;
    let total = 0;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        total = e.total;
        onProgress(e.loaded, e.total);
      }
    };
    // 请求体发完、服务器开始处理时再报一次 100%：最后一个 progress 事件不一定到 total
    xhr.upload.onload = () => {
      if (onProgress && total) onProgress(total, total);
    };
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    xhr.onabort = () => reject(Object.assign(new Error('已取消'), { aborted: true }));
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* 非 JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data?.error || (xhr.status === 413 ? '文件太大，超过了服务器允许的上传大小' : `请求失败（HTTP ${xhr.status}）`)));
    };
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(form);
  });
}

// ---------------------------------------------------------------- 提示
let toastBox;
export function toast(message, kind = 'info') {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const el = h('div', { class: `toast ${kind}` }, message);
  el.addEventListener('click', () => el.remove());
  toastBox.append(el);
  while (toastBox.children.length > 4) toastBox.firstChild.remove();
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 2600);
}

// ---------------------------------------------------------------- 对话框
/** closable: false 时没有关闭按钮，Esc 和点遮罩都不会关（用于不能中断的进度） */
export function dialog({ title, body, footer, wide, onClose, closable = true }) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && closable) close();
  };
  const box = h(
    'div',
    { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', {}, h('h3', {}, title), closable ? h('button', { class: 'btn ghost sm', 'aria-label': '关闭', onClick: close }, icon('x')) : null),
    h('div', { class: 'body' }, ...[].concat(body)),
    footer ? h('footer', {}, ...[].concat(footer)) : null,
  );
  const backdrop = h('div', { class: 'backdrop', onMousedown: (e) => closable && e.target === backdrop && close() }, box);
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  setTimeout(() => box.querySelector('input, textarea, button.primary')?.focus(), 30);
  return { close, box };
}

export function confirmDialog({ title, message, confirmText = '确定', danger = false }) {
  return new Promise((resolve) => {
    // 先给出结果再关闭：关闭会触发 onClose，不能让它把结果覆盖成“取消”
    let settled = false;
    const finish = (v) => {
      settled = true;
      resolve(v);
      d.close();
    };
    const d = dialog({
      title,
      body: h('p', {}, message),
      footer: [
        h('button', { class: 'btn', onClick: () => finish(false) }, '取消'),
        h('button', { class: `btn primary${danger ? ' danger' : ''}`, onClick: () => finish(true) }, confirmText),
      ],
      onClose: () => {
        if (!settled) resolve(false);
      },
    });
  });
}

export function promptDialog({ title, label, value = '', placeholder = '', confirmText = '确定', multiline = false }) {
  return new Promise((resolve) => {
    const input = multiline
      ? h('textarea', { class: 'input', placeholder }, value)
      : h('input', { class: 'input', value, placeholder, maxlength: 80 });
    let settled = false;
    const finish = (v) => {
      settled = true;
      resolve(v);
      d.close();
    };
    const d = dialog({
      title,
      body: h(
        'form',
        { class: 'field', onSubmit: (e) => (e.preventDefault(), finish(input.value)) },
        label ? h('label', {}, label) : null,
        input,
      ),
      footer: [h('button', { class: 'btn', onClick: () => finish(null) }, '取消'), h('button', { class: 'btn primary', onClick: () => finish(input.value) }, confirmText)],
      onClose: () => {
        if (!settled) resolve(null);
      },
    });
  });
}

// ---------------------------------------------------------------- 剪贴板
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }, text);
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** 把图片地址渲染成 PNG blob（动图取第一帧） */
async function toPngBlob(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth || 256;
  canvas.height = img.naturalHeight || 256;
  canvas.getContext('2d').drawImage(img, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片转换失败');
  return blob;
}

/**
 * 把图片复制到剪贴板。浏览器只接受 PNG；GIF 会复制第一帧。
 * 必须在用户点击事件中调用，且页面需为 HTTPS 或 localhost。
 */
export async function copyImage(url) {
  if (!navigator.clipboard || !window.ClipboardItem) throw new Error('这个浏览器不支持复制图片，可以右键另存');
  // Safari 要求 ClipboardItem 在点击的同一个事件循环里创建，所以传 Promise
  const item = new ClipboardItem({ 'image/png': toPngBlob(url) });
  await navigator.clipboard.write([item]);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export const RELEASES_URL = 'https://github.com/Lony225/emoji-manager/releases/latest';

// ---------------------------------------------------------------- 分组树（表情包的 path = "分组 / 名称"，首页和后台共用）
/** 把扁平的表情包列表按路径搭成树。节点：{ path, name, pack, children, count }，count 是节点下的表情总数 */
export function buildTree(packs) {
  const root = { path: '', name: '', pack: null, children: [], count: 0 };
  const byPath = new Map([['', root]]);
  const ensure = (path) => {
    let node = byPath.get(path);
    if (node) return node;
    const segs = path.split(' / ');
    const parent = ensure(segs.slice(0, -1).join(' / '));
    node = { path, name: segs[segs.length - 1], pack: null, children: [], count: 0 };
    parent.children.push(node);
    byPath.set(path, node);
    return node;
  };
  for (const p of packs) ensure(p.path).pack = p;
  const tally = (n) => (n.count = (n.pack ? n.pack.stickers.length : 0) + n.children.reduce((s, c) => s + tally(c), 0));
  tally(root);
  return { root, byPath };
}

/** 节点下的表情包数量（含它自己） */
export function countPacks(node) {
  return (node.pack ? 1 : 0) + node.children.reduce((s, c) => s + countPacks(c), 0);
}

const encodePath = (path) => path.split(' / ').map(encodeURIComponent).join('/');
/** 分组的订阅地址：/groups/一级/二级/manifest.json */
export function groupManifestUrl(path) {
  return `${location.origin}/groups/${encodePath(path)}/manifest.json`;
}
export function groupZipUrl(path) {
  return `/groups/${encodePath(path)}.zip`;
}
