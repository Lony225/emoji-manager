import { $, h, icon, api, toast, dialog, copyText, copyImage, formatBytes, RELEASES_URL, buildTree, countPacks, groupManifestUrl, groupZipUrl, fallbackToOriginal } from './common.js?v=2';

// 省带宽的首页：只放分类卡片（每张卡几张小缩略图），点进分类才加载它的表情；
// 表情网格一律用静态缩略图（动图只有第一帧），点击复制 / 下载时才取原图。
const state = { site: null, packs: [], tree: buildTree([]), query: '' };

// 地址栏 hash 记住当前在哪个分类：#/n/<路径>
function route() {
  const m = location.hash.match(/^#\/n\/(.+)$/);
  if (!m) return { kind: 'home' };
  try {
    return { kind: 'node', path: decodeURIComponent(m[1]) };
  } catch {
    return { kind: 'home' };
  }
}
const nodeHash = (path) => `#/n/${encodeURIComponent(path)}`;
window.addEventListener('hashchange', () => {
  closeMenu();
  window.scrollTo(0, 0);
  render();
});

async function load() {
  try {
    state.site = await api('/api/site');
    state.packs = state.site.packs;
    state.tree = buildTree(state.packs);
    document.title = state.site.title;
    $('#brand-title').textContent = state.site.title;
    render();
  } catch (e) {
    $('#app').replaceChildren(h('div', { class: 'empty' }, h('h3', {}, '加载失败'), h('p', {}, e.message)));
  }
}
$('#brand-icon').append(icon('smile', 18));

// ---------------------------------------------------------------- 导入到桌面应用
function packUrl(packId) {
  return packId ? `${location.origin}/packs/${packId}/manifest.json` : `${location.origin}/manifest.json`;
}

/** 用 emojimanager:// 协议唤起桌面应用；没装的话稍后给提示 */
function importToApp(url, label) {
  let left = false;
  const onBlur = () => (left = true);
  window.addEventListener('blur', onBlur);
  location.href = `emojimanager://subscribe?url=${encodeURIComponent(url)}`;
  setTimeout(() => {
    window.removeEventListener('blur', onBlur);
    if (left || document.hidden) {
      toast('已交给表情包管理器处理，请在应用里确认添加', 'success');
      return;
    }
    const input = h('input', { class: 'input', value: url, readonly: true, onClick: (e) => e.target.select() });
    const d = dialog({
      title: '没有打开表情包管理器？',
      body: [
        h('p', {}, '一键导入需要安装表情包管理器 1.1 及以上版本。也可以复制下面的订阅地址，在应用里点「添加订阅」粘贴。'),
        h('div', { class: 'url-box' }, input, h('button', { class: 'btn', onClick: () => copyText(url).then(() => toast('已复制订阅地址', 'success')) }, icon('copy'), '复制')),
        h('p', { class: 'hint' }, `订阅内容：${label}`),
      ],
      footer: [
        h('a', { class: 'btn', href: RELEASES_URL, target: '_blank', rel: 'noopener' }, icon('download'), '下载表情包管理器'),
        h('button', { class: 'btn primary', onClick: () => d.close() }, '知道了'),
      ],
    });
  }, 1500);
}

function copySubscription(url) {
  copyText(url).then((ok) => toast(ok ? '已复制订阅地址，到应用里「添加订阅」粘贴即可' : '复制失败', ok ? 'success' : 'error'));
}

// ---------------------------------------------------------------- 表情
const stamps = new Map();
function setStamp(card, state) {
  const old = card.querySelector('.stamp');
  old?.remove();
  if (!state) return;
  card.append(h('div', { class: `stamp ${state}` }, h('span', {}, state === 'done' ? '已复制' : '复制中…')));
}

async function copySticker(card, s) {
  setStamp(card, 'pending');
  try {
    await copyImage(s.url);
    setStamp(card, 'done');
    clearTimeout(stamps.get(s.id));
    stamps.set(s.id, setTimeout(() => setStamp(card, null), 900));
    if (s.ext === 'gif' || s.ext === 'webp' || s.ext === 'avif') toast('动图复制的是第一帧；要发动图请用右键「下载原图」或导入到应用里发送');
  } catch (e) {
    setStamp(card, null);
    toast(e.message, 'error');
  }
}

let menu = null;
function closeMenu() {
  menu?.remove();
  menu = null;
}
document.addEventListener('mousedown', (e) => {
  if (menu && !menu.contains(e.target)) closeMenu();
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
window.addEventListener('scroll', closeMenu, true);

function stickerMenu(e, card, s) {
  e.preventDefault();
  closeMenu();
  const abs = `${location.origin}${s.url}`;
  menu = h(
    'div',
    { class: 'menu', role: 'menu' },
    h('button', { onClick: () => (closeMenu(), copySticker(card, s)) }, '复制图片'),
    h('button', { onClick: () => (closeMenu(), copyText(abs).then(() => toast('已复制图片链接', 'success'))) }, '复制图片链接'),
    h('a', { href: s.url, download: `${s.name}.${s.ext}`, onClick: closeMenu }, `下载原图（${formatBytes(s.size)}）`),
    h('a', { href: s.url, target: '_blank', rel: 'noopener', onClick: closeMenu }, '在新标签页打开'),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
}

/** 表情卡片：显示的是静态缩略图，点击复制原图 */
function stickerCard(s) {
  const card = h(
    'div',
    { class: 'card', role: 'button', tabindex: 0, title: `${s.name}${s.tags.length ? `\n${s.tags.map((t) => '#' + t).join(' ')}` : ''}${s.animated ? '\n动图，点击复制原图' : ''}` },
    h('div', { class: 'thumb' }, h('img', { src: s.thumb || s.url, alt: s.name, loading: 'lazy', decoding: 'async', onError: fallbackToOriginal(s) })),
    s.animated ? h('span', { class: 'badge' }, s.ext === 'gif' ? 'GIF' : '动图') : null,
    h('div', { class: 'name' }, s.name),
  );
  card.addEventListener('click', () => copySticker(card, s));
  card.addEventListener('contextmenu', (e) => stickerMenu(e, card, s));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      copySticker(card, s);
    }
  });
  return card;
}

// ---------------------------------------------------------------- 分类卡片
/** 卡片封面：这个节点下前几张表情的缩略图 */
function coverThumbs(node, max = 4) {
  const out = [];
  const walk = (n) => {
    if (out.length >= max) return;
    if (n.pack) for (const s of n.pack.stickers) {
      if (out.length >= max) break;
      out.push(s);
    }
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

function nodeCard(node) {
  const covers = coverThumbs(node);
  const isGroup = node.children.length > 0;
  return h(
    'a',
    { class: 'cat-card', href: nodeHash(node.path), title: node.path },
    h(
      'div',
      { class: `covers n${Math.min(covers.length, 4)}` },
      // 封面很小（几 KB），直接加载，不用 lazy
      ...covers.map((s) => h('img', { src: s.thumb || s.url, alt: '', decoding: 'async', onError: fallbackToOriginal(s) })),
      covers.length === 0 ? h('span', { class: 'hint' }, '还没有表情') : null,
    ),
    h('div', { class: 'title' }, icon(isGroup ? 'folder' : 'image', 15), h('span', {}, node.name)),
    h('div', { class: 'meta hint' }, isGroup ? `${countPacks(node)} 个表情包 · ${node.count} 个表情` : `${node.count} 个表情`),
  );
}

function breadcrumb(node) {
  const segs = node.path.split(' / ');
  const items = [h('a', { href: '#/' }, '首页')];
  segs.forEach((seg, i) => {
    items.push(h('span', {}, '/'));
    items.push(i === segs.length - 1 ? h('span', { class: 'current' }, seg) : h('a', { href: nodeHash(segs.slice(0, i + 1).join(' / ')) }, seg));
  });
  return h('div', { class: 'breadcrumb' }, ...items);
}

// ---------------------------------------------------------------- 页面
function hero() {
  const total = state.packs.reduce((n, p) => n + p.stickers.length, 0);
  return h(
    'div',
    { class: 'hero' },
    h('h1', {}, state.site.title),
    state.site.description ? h('p', {}, state.site.description) : h('p', {}, '点进分类浏览，点一下表情就复制到剪贴板，去聊天窗口粘贴；也可以一键导入到表情包管理器，之后自动同步更新。'),
    h(
      'div',
      { class: 'actions' },
      h('button', { class: 'btn primary', onClick: () => importToApp(packUrl(null), state.site.title), disabled: total === 0 }, icon('rocket'), '一键导入全部'),
      h('button', { class: 'btn', onClick: () => copySubscription(packUrl(null)), disabled: total === 0 }, icon('link'), '复制订阅地址'),
      h('a', { class: `btn${total ? '' : ' disabled'}`, href: '/all.zip' }, icon('download'), '下载全部 zip'),
      h('a', { class: 'btn ghost', href: RELEASES_URL, target: '_blank', rel: 'noopener' }, '获取表情包管理器'),
    ),
  );
}

function homeView() {
  const tops = state.tree.root.children;
  return [
    hero(),
    tops.length
      ? [h('h2', { class: 'section-title' }, '分类', h('span', { class: 'hint' }, ' 点进去看表情')), h('div', { class: 'cat-grid' }, ...tops.map(nodeCard))]
      : h('div', { class: 'empty' }, h('h3', {}, '还没有表情包'), h('p', {}, '管理员登录后就能上传。')),
  ];
}

function nodeView(node) {
  const isGroup = node.children.length > 0;
  const url = isGroup ? groupManifestUrl(node.path) : packUrl(node.pack.id);
  const zip = isGroup ? groupZipUrl(node.path) : `/packs/${node.pack.id}.zip`;
  const metaBits = [isGroup ? `${countPacks(node)} 个表情包` : null, `${node.count} 个表情`, node.pack?.description || null].filter(Boolean);
  const parts = [
    breadcrumb(node),
    h(
      'div',
      { class: 'node-head' },
      icon(isGroup ? 'folder' : 'image', 22),
      h('div', { class: 'text' }, h('h1', {}, node.name), h('div', { class: 'hint' }, metaBits.join(' · ')), node.pack?.tags.length ? h('div', { class: 'hint' }, node.pack.tags.map((t) => '#' + t).join(' ')) : null),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn sm primary', onClick: () => importToApp(url, node.path), title: isGroup ? '把这个分类连同所有子分类导入桌面应用' : '用 emojimanager:// 协议打开桌面应用并添加订阅' }, icon('rocket', 14), isGroup ? '导入整个分类' : '导入到表情包管理器'),
        h('button', { class: 'btn sm', onClick: () => copySubscription(url), title: url }, icon('link', 14), '复制订阅地址'),
        h('a', { class: 'btn sm', href: zip }, icon('download', 14), '下载 zip'),
      ),
    ),
  ];
  if (isGroup) parts.push(h('h2', { class: 'section-title' }, '子分类'), h('div', { class: 'cat-grid' }, ...node.children.map(nodeCard)));
  if (node.pack) {
    parts.push(h('h2', { class: 'section-title' }, isGroup ? `“${node.name}”自己的表情` : '表情', h('span', { class: 'hint' }, ' 点击复制原图，右键更多操作')));
    parts.push(node.pack.stickers.length ? h('div', { class: 'grid' }, ...node.pack.stickers.map(stickerCard)) : h('div', { class: 'empty' }, '这个表情包还是空的'));
  }
  return parts;
}

function matches(s, q) {
  const hay = `${s.name} ${s.tags.join(' ')}`.toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

const SEARCH_LIMIT = 240;
function searchView(q) {
  const sections = [];
  let shown = 0;
  for (const p of state.packs) {
    const list = p.stickers.filter((s) => matches(s, q));
    if (!list.length) continue;
    const slice = list.slice(0, Math.max(0, SEARCH_LIMIT - shown));
    shown += slice.length;
    sections.push(
      h(
        'section',
        { class: 'pack' },
        h('div', { class: 'pack-head' }, h('h2', {}, h('a', { href: nodeHash(p.path) }, p.path)), h('span', { class: 'count num' }, `${list.length} 个`)),
        h('div', { class: 'grid' }, ...slice.map(stickerCard)),
      ),
    );
    if (shown >= SEARCH_LIMIT) {
      sections.push(h('p', { class: 'hint' }, `结果太多，只显示前 ${SEARCH_LIMIT} 个，换个更具体的词试试。`));
      break;
    }
  }
  return [
    h(
      'div',
      { class: 'search-head' },
      h('h1', {}, `搜索“${state.query.trim()}”`),
      h('span', { class: 'hint' }, sections.length ? `${shown} 个结果` : '没有匹配的表情'),
      h('button', { class: 'btn sm ghost', onClick: () => (($('#search').value = ''), (state.query = ''), render()) }, '清除'),
    ),
    ...sections,
  ];
}

function footer() {
  const total = state.packs.reduce((n, p) => n + p.stickers.length, 0);
  return h(
    'footer',
    { class: 'foot' },
    h('span', {}, `共 ${state.packs.length} 个表情包、${total} 个表情`),
    h('a', { href: '/manifest.json' }, '订阅清单'),
    h('a', { href: 'https://github.com/Lony225/emoji-manager', target: '_blank', rel: 'noopener' }, '表情包管理器'),
    h('span', {}, '列表里是缩略图，点击复制原图，右键更多操作'),
  );
}

function render() {
  const q = state.query.trim().toLowerCase();
  const r = route();
  let body;
  if (q) body = searchView(q);
  else if (r.kind === 'node' && state.tree.byPath.has(r.path)) body = nodeView(state.tree.byPath.get(r.path));
  else body = homeView();
  // 数组要摊平、null 要去掉，否则 replaceChildren 会把它们当成文本
  $('#app').replaceChildren(...[...body, footer()].flat(2).filter(Boolean));
}

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value;
    render();
  }, 120);
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && document.activeElement !== $('#search')) {
    e.preventDefault();
    $('#search').focus();
  }
});

load();
export { formatBytes };
