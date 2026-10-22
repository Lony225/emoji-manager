import { $, h, icon, api, toast, dialog, copyText, copyImage, formatBytes, RELEASES_URL } from './common.js';

const state = { site: null, packs: [], active: 'all', query: '' };

async function load() {
  try {
    state.site = await api('/api/site');
    state.packs = state.site.packs;
    document.title = state.site.title;
    $('#brand-title').textContent = state.site.title;
    render();
  } catch (e) {
    $('#app').replaceChildren(h('div', { class: 'empty' }, h('h3', {}, '加载失败'), h('p', {}, e.message)));
  }
}
$('#brand-icon').append(icon('smile', 18));

// ---------------------------------------------------------------- 导入到桌面应用
function manifestUrl(packId) {
  return packId ? `${location.origin}/packs/${packId}/manifest.json` : `${location.origin}/manifest.json`;
}

/** 用 emojimanager:// 协议唤起桌面应用；没装的话稍后给提示 */
function importToApp(packId, label) {
  const url = manifestUrl(packId);
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

function copySubscription(packId) {
  copyText(manifestUrl(packId)).then((ok) => toast(ok ? '已复制订阅地址，到应用里「添加订阅」粘贴即可' : '复制失败', ok ? 'success' : 'error'));
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
    h('a', { href: s.url, download: `${s.name}.${s.ext}`, onClick: closeMenu }, '下载原图'),
    h('a', { href: s.url, target: '_blank', rel: 'noopener', onClick: closeMenu }, '在新标签页打开'),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
}

function stickerCard(s) {
  const card = h(
    'div',
    { class: 'card', role: 'button', tabindex: 0, title: s.tags.length ? `${s.name}\n${s.tags.map((t) => '#' + t).join(' ')}` : s.name },
    h('div', { class: 'thumb' }, h('img', { src: s.url, alt: s.name, loading: 'lazy', decoding: 'async' })),
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

// ---------------------------------------------------------------- 渲染
function matches(s, q) {
  if (!q) return true;
  const hay = `${s.name} ${s.tags.join(' ')}`.toLowerCase();
  return q.split(/\s+/).every((t) => hay.includes(t));
}

function packSection(p, q) {
  const list = p.stickers.filter((s) => matches(s, q));
  if (q && list.length === 0) return null;
  return h(
    'section',
    { class: 'pack', id: `pack-${p.id}` },
    h(
      'div',
      { class: 'pack-head' },
      h('h2', {}, p.name),
      h('span', { class: 'count num' }, `${list.length}${q ? ` / ${p.stickers.length}` : ''} 个`),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn sm primary', onClick: () => importToApp(p.id, p.name), title: '用 emojimanager:// 协议打开桌面应用并添加订阅' }, icon('rocket', 14), '导入到表情包管理器'),
        h('button', { class: 'btn sm', onClick: () => copySubscription(p.id), title: manifestUrl(p.id) }, icon('link', 14), '复制订阅地址'),
        h('a', { class: 'btn sm', href: `/packs/${p.id}.zip` }, icon('download', 14), '下载 zip'),
      ),
      p.description ? h('p', { class: 'desc' }, p.description) : null,
    ),
    list.length ? h('div', { class: 'grid' }, ...list.map(stickerCard)) : h('div', { class: 'empty' }, '这个表情包还是空的'),
  );
}

function render() {
  const app = $('#app');
  const q = state.query.trim().toLowerCase();
  const total = state.packs.reduce((n, p) => n + p.stickers.length, 0);
  const shown = state.active === 'all' ? state.packs : state.packs.filter((p) => p.id === state.active);
  const sections = shown.map((p) => packSection(p, q)).filter(Boolean);

  const children = [
    h(
      'div',
      { class: 'hero' },
      h('h1', {}, state.site.title),
      state.site.description ? h('p', {}, state.site.description) : h('p', {}, '点一下表情就复制到剪贴板，去聊天窗口粘贴；也可以一键导入到表情包管理器，之后自动同步更新。'),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', onClick: () => importToApp(null, state.site.title), disabled: total === 0 }, icon('rocket'), '一键导入全部'),
        h('button', { class: 'btn', onClick: () => copySubscription(null), disabled: total === 0 }, icon('link'), '复制订阅地址'),
        h('a', { class: `btn${total ? '' : ' disabled'}`, href: '/all.zip' }, icon('download'), '下载全部 zip'),
        h('a', { class: 'btn ghost', href: RELEASES_URL, target: '_blank', rel: 'noopener' }, '获取表情包管理器'),
      ),
    ),
    state.packs.length > 1
      ? h(
          'nav',
          { class: 'tabs', role: 'tablist' },
          h('button', { class: `chip${state.active === 'all' ? ' active' : ''}`, role: 'tab', onClick: () => ((state.active = 'all'), render()) }, '全部', h('span', { class: 'count num' }, total)),
          ...state.packs.map((p) =>
            h('button', { class: `chip${state.active === p.id ? ' active' : ''}`, role: 'tab', onClick: () => ((state.active = p.id), render()) }, p.name, h('span', { class: 'count num' }, p.stickers.length)),
          ),
        )
      : null,
    sections.length
      ? sections
      : h('div', { class: 'empty' }, h('h3', {}, total === 0 ? '还没有表情包' : '没有匹配的表情'), h('p', {}, total === 0 ? '管理员登录后就能上传。' : '换个关键词试试。')),
    h(
      'footer',
      { class: 'foot' },
      h('span', {}, `共 ${state.packs.length} 个表情包、${total} 个表情`),
      h('a', { href: '/manifest.json' }, '订阅清单'),
      h('a', { href: 'https://github.com/Lony225/emoji-manager', target: '_blank', rel: 'noopener' }, '表情包管理器'),
      h('span', {}, '点击表情复制，右键更多操作'),
    ),
  ];
  // 数组要摊平、null 要去掉，否则 replaceChildren 会把它们当成文本
  app.replaceChildren(...children.flat().filter(Boolean));
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
