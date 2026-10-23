import { $, h, icon, api, upload, toast, dialog, confirmDialog, promptDialog, copyText, formatBytes, buildTree, countPacks, groupManifestUrl, groupZipUrl, fallbackToOriginal } from './common.js?v=2';

// active 是侧栏树里选中的节点路径（"分组 / 名称"）；节点可能是一个表情包、一个分组，或两者都是
const state = { admin: false, site: null, packs: [], tree: buildTree([]), active: null, selection: new Set(), uploading: null, collapsed: new Set() };
$('#brand-icon').append(icon('smile', 18));

async function refresh() {
  state.site = await api('/api/site');
  state.packs = state.site.packs;
  state.tree = buildTree(state.packs);
  document.title = `管理 · ${state.site.title}`;
  $('#brand-title').textContent = state.site.title;
  // 选中的节点没了（删除 / 改名）就退回最近的上级
  let a = state.active;
  while (a !== null && !state.tree.byPath.has(a)) {
    const i = a.lastIndexOf(' / ');
    a = i < 0 ? null : a.slice(0, i);
  }
  state.active = a;
  if (state.active === null && state.tree.root.children.length) state.active = state.tree.root.children[0].path;
  render();
}

async function boot() {
  try {
    const me = await api('/api/me');
    state.admin = me.admin;
    if (state.admin) await refresh();
    else {
      state.site = await api('/api/site');
      renderLogin();
    }
  } catch (e) {
    $('#app').replaceChildren(h('div', { class: 'empty' }, h('h3', {}, '加载失败'), h('p', {}, e.message)));
  }
}

// ---------------------------------------------------------------- 登录
function renderLogin() {
  $('#top-actions').replaceChildren();
  const pw = h('input', { class: 'input', type: 'password', placeholder: '管理员口令', autocomplete: 'current-password', autofocus: true });
  const err = h('div', { class: 'error-text' });
  const form = h(
    'form',
    {
      class: 'panel login',
      onSubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        try {
          await api('/api/login', { method: 'POST', body: { password: pw.value } });
          state.admin = true;
          await refresh();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    },
    h('h2', {}, '管理员登录'),
    state.site?.passwordSet === false ? h('p', { class: 'error-text' }, '服务器还没有设置口令，请先在服务器上运行 set-password。') : null,
    h('div', { class: 'field' }, h('label', {}, '口令'), pw),
    err,
    h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '10px' } }, h('a', { class: 'btn ghost', href: '/' }, '返回首页'), h('button', { class: 'btn primary', type: 'submit' }, '登录')),
  );
  $('#app').replaceChildren(form);
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  state.admin = false;
  renderLogin();
}

// ---------------------------------------------------------------- 表情包
function select(path) {
  state.active = path;
  state.selection.clear();
  render();
}

/** 新建 / 编辑表情包：名称、所属分组、说明、包级标签 */
function packDialog({ title, pack, group = '', confirmText, onSave }) {
  const name = h('input', { class: 'input', value: pack?.name ?? '', maxlength: 80, placeholder: '例如：猫猫' });
  const grp = h('input', { class: 'input', value: pack?.group ?? group, placeholder: '留空为一级；多级用 / 分隔，如：动物 / 猫' });
  const desc = h('textarea', { class: 'input', placeholder: '可选，显示在表情包标题下方' }, pack?.description ?? '');
  const tags = h('input', { class: 'input', value: (pack?.tags ?? []).join(', '), placeholder: '用逗号分隔，会加到这个包里的每个表情上' });
  const err = h('div', { class: 'error-text' });
  const d = dialog({
    title,
    body: [
      h('div', { class: 'field' }, h('label', {}, '名称'), name),
      h('div', { class: 'field' }, h('label', {}, '所属分组（父分类路径）'), grp, h('div', { class: 'hint' }, '同一分组下的表情包会被分组的订阅地址一起带上，订阅后成为同样的分类层级。')),
      h('div', { class: 'field' }, h('label', {}, '说明'), desc),
      h('div', { class: 'field' }, h('label', {}, '包级标签'), tags),
      err,
    ],
    footer: [
      h('button', { class: 'btn', onClick: () => d.close() }, '取消'),
      h(
        'button',
        {
          class: 'btn primary',
          onClick: async () => {
            if (!name.value.trim()) {
              err.textContent = '名称不能为空';
              return;
            }
            try {
              await onSave({ name: name.value, group: grp.value, description: desc.value, tags: tags.value });
              d.close();
            } catch (e) {
              err.textContent = e.message;
            }
          },
        },
        confirmText,
      ),
    ],
  });
  setTimeout(() => name.focus(), 50);
}

function newPack(group = '') {
  packDialog({
    title: group ? `在“${group}”下新建表情包` : '新建表情包',
    group,
    confirmText: '创建',
    onSave: async (body) => {
      const p = await api('/api/packs', { method: 'POST', body });
      state.active = p.path;
      await refresh();
      toast(`已创建“${p.path}”`, 'success');
    },
  });
}

function editPack(p) {
  packDialog({
    title: '编辑表情包',
    pack: p,
    confirmText: '保存',
    onSave: async (body) => {
      const np = await api(`/api/packs/${p.id}`, { method: 'PATCH', body });
      state.active = np.path;
      await refresh();
      toast('已保存', 'success');
    },
  });
}

async function deletePack(p) {
  const ok = await confirmDialog({ title: `删除表情包“${p.path}”？`, message: `里面的 ${p.stickers.length} 个表情和图片文件会一起删除，订阅了它的人下次同步时也会移除。`, confirmText: '删除', danger: true });
  if (!ok) return;
  await api(`/api/packs/${p.id}`, { method: 'DELETE' });
  await refresh();
  toast('已删除');
}

// ---------------------------------------------------------------- 上传
async function uploadFiles(pack, files) {
  const list = Array.from(files).filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(f.name));
  if (list.length === 0) {
    toast('没有可上传的图片', 'error');
    return;
  }
  const totals = { added: 0, skipped: 0, failed: 0, errors: [] };
  state.uploading = { done: 0, total: list.length };
  render();
  // 每批 20 张，避免单个请求过大
  for (let i = 0; i < list.length; i += 20) {
    const form = new FormData();
    for (const f of list.slice(i, i + 20)) form.append('files', f, f.name);
    try {
      const r = await api(`/api/packs/${pack.id}/stickers`, { method: 'POST', form });
      totals.added += r.added;
      totals.skipped += r.skipped;
      totals.failed += r.failed;
      totals.errors.push(...r.errors);
    } catch (e) {
      totals.failed += Math.min(20, list.length - i);
      totals.errors.push(e.message);
    }
    state.uploading.done = Math.min(list.length, i + 20);
    render();
  }
  state.uploading = null;
  await refresh();
  const parts = [];
  if (totals.added) parts.push(`已上传 ${totals.added} 个`);
  if (totals.skipped) parts.push(`跳过 ${totals.skipped} 个重复或不支持的文件`);
  if (totals.failed) parts.push(`${totals.failed} 个失败`);
  toast(parts.join('，') || '没有新的表情', totals.failed ? 'error' : 'success');
  if (totals.errors.length) console.warn(totals.errors);
}

function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
    input.addEventListener('change', () => (resolve(Array.from(input.files)), input.remove()));
    document.body.append(input);
    input.click();
  });
}

async function importZip() {
  const [file] = await pickFiles('.zip,application/zip', false);
  if (!file) return;
  const form = new FormData();
  form.append('file', file, file.name);
  // 进度对话框：上传阶段显示百分比、已传大小、速度、剩余时间；传完后服务器解包入库时显示滚动条
  const ac = new AbortController();
  const bar = h('div', { style: { width: '0%' } });
  const track = h('div', { class: 'progress big' }, bar);
  const pctEl = h('strong', { class: 'num', style: { fontSize: '20px' } }, '0%');
  const detail = h('span', { class: 'hint num' }, `0 B / ${formatBytes(file.size)}`);
  const phase = h('div', { class: 'hint' }, '正在上传到服务器…');
  const cancelBtn = h('button', { class: 'btn', onClick: () => ac.abort() }, '取消');
  const d = dialog({
    title: `导入 ${file.name}`,
    closable: false,
    body: [h('div', { class: 'row', style: { justifyContent: 'space-between', alignItems: 'baseline' } }, pctEl, detail), track, phase],
    footer: [cancelBtn],
  });
  const t0 = Date.now();
  let uploaded = false;
  const onProgress = (loaded, total) => {
    if (uploaded) return;
    const pct = Math.min(100, Math.floor((100 * loaded) / total));
    bar.style.width = `${pct}%`;
    pctEl.textContent = `${pct}%`;
    const secs = (Date.now() - t0) / 1000;
    const speed = secs > 0.5 ? loaded / secs : 0;
    const left = speed > 0 ? Math.ceil((total - loaded) / speed) : 0;
    detail.textContent = `${formatBytes(loaded)} / ${formatBytes(total)}${speed ? ` · ${formatBytes(speed)}/s` : ''}${left > 0 && loaded < total ? ` · 剩余约 ${formatDuration(left)}` : ''}`;
    if (loaded >= total) {
      uploaded = true;
      track.classList.add('indeterminate');
      pctEl.textContent = '100%';
      detail.textContent = `${formatBytes(total)} · 用时 ${formatDuration(Math.round(secs))}`;
      phase.textContent = '上传完成，服务器正在解包并入库，大包可能要等一会儿…';
      cancelBtn.disabled = true;
    }
  };
  try {
    const r = await upload('/api/import', form, onProgress, { signal: ac.signal });
    d.close();
    await refresh();
    toast(`已导入 ${r.added} 个表情到 ${r.names.length} 个表情包${r.packs ? `（新建 ${r.packs} 个）` : ''}${r.skipped ? `，跳过 ${r.skipped} 个重复` : ''}${r.missing ? `，${r.missing} 个缺少图片` : ''}`, 'success');
  } catch (e) {
    d.close();
    if (e.aborted) toast('已取消导入');
    else toast(`导入失败：${e.message}`, 'error');
  }
}

function formatDuration(secs) {
  if (secs < 60) return `${secs} 秒`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return secs < 3600 ? `${m} 分${s ? ` ${s} 秒` : ''}` : `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

// ---------------------------------------------------------------- 表情
async function renameSticker(s) {
  const name = await promptDialog({ title: '重命名', value: s.name, confirmText: '保存' });
  if (name === null || !name.trim() || name === s.name) return;
  await api(`/api/stickers/${s.id}`, { method: 'PATCH', body: { name } });
  await refresh();
}

async function editTags(s) {
  const tags = await promptDialog({ title: `标签：${s.name}`, label: '用逗号分隔', value: s.tags.join(', '), confirmText: '保存' });
  if (tags === null) return;
  await api(`/api/stickers/${s.id}`, { method: 'PATCH', body: { tags } });
  await refresh();
}

async function deleteSelected() {
  const ids = Array.from(state.selection);
  const ok = await confirmDialog({ title: `删除 ${ids.length} 个表情？`, message: '图片文件会一并删除。', confirmText: '删除', danger: true });
  if (!ok) return;
  await api('/api/stickers/delete', { method: 'POST', body: { ids } });
  state.selection.clear();
  await refresh();
  toast(`已删除 ${ids.length} 个表情`);
}

async function moveSelected(current) {
  const ids = Array.from(state.selection);
  const others = state.packs.filter((p) => p.id !== current.id);
  if (others.length === 0) {
    toast('没有别的表情包可以移过去');
    return;
  }
  const d = dialog({
    title: `把 ${ids.length} 个表情移到…`,
    body: h(
      'div',
      { class: 'field' },
      ...others.map((p) =>
        h(
          'button',
          {
            class: 'btn',
            style: { justifyContent: 'flex-start' },
            onClick: async () => {
              d.close();
              await api('/api/stickers/move', { method: 'POST', body: { ids, packId: p.id } });
              state.selection.clear();
              await refresh();
              toast(`已移到“${p.path}”`, 'success');
            },
          },
          icon('image'),
          p.path,
        ),
      ),
    ),
  });
}

function stickerCard(s) {
  const selected = state.selection.has(s.id);
  const card = h(
    'div',
    { class: `card${selected ? ' selected' : ''}`, title: s.tags.length ? `${s.name}\n${s.tags.map((t) => '#' + t).join(' ')}` : s.name },
    h('div', { class: 'thumb' }, h('img', { src: s.thumb || s.url, alt: s.name, loading: 'lazy', decoding: 'async', onError: fallbackToOriginal(s) })),
    s.animated ? h('span', { class: 'badge' }, s.ext === 'gif' ? 'GIF' : '动图') : null,
    h('button', { class: 'check', 'aria-label': selected ? '取消选择' : '选择', onClick: (e) => (e.stopPropagation(), toggle(s.id)) }, selected ? icon('check', 13) : null),
    h('div', { class: 'name', title: '点击改名', onClick: (e) => (e.stopPropagation(), renameSticker(s)) }, s.name),
  );
  card.addEventListener('click', () => toggle(s.id));
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    editTags(s);
  });
  return card;
}

function toggle(id) {
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  render();
}

// ---------------------------------------------------------------- 站点设置
function siteSettings() {
  const title = h('input', { class: 'input', value: state.site.title, maxlength: 80 });
  const desc = h('textarea', { class: 'input' }, state.site.description);
  const d = dialog({
    title: '站点设置',
    body: [
      h('div', { class: 'field' }, h('label', {}, '站点名称（也是整站订阅的名称）'), title),
      h('div', { class: 'field' }, h('label', {}, '首页说明'), desc),
      h('button', { class: 'btn', onClick: () => (d.close(), changePassword()) }, '修改管理员口令…'),
    ],
    footer: [
      h('button', { class: 'btn', onClick: () => d.close() }, '取消'),
      h(
        'button',
        {
          class: 'btn primary',
          onClick: async () => {
            await api('/api/site', { method: 'PATCH', body: { title: title.value, description: desc.value } });
            d.close();
            await refresh();
            toast('已保存', 'success');
          },
        },
        '保存',
      ),
    ],
  });
}

function changePassword() {
  const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'error-text' });
  const d = dialog({
    title: '修改管理员口令',
    body: [h('div', { class: 'field' }, h('label', {}, '当前口令'), cur), h('div', { class: 'field' }, h('label', {}, '新口令（至少 6 位）'), next), err],
    footer: [
      h('button', { class: 'btn', onClick: () => d.close() }, '取消'),
      h(
        'button',
        {
          class: 'btn primary',
          onClick: async () => {
            try {
              await api('/api/password', { method: 'POST', body: { current: cur.value, next: next.value } });
              d.close();
              toast('口令已修改', 'success');
            } catch (e) {
              err.textContent = e.message;
            }
          },
        },
        '修改',
      ),
    ],
  });
}

// ---------------------------------------------------------------- 渲染
function toggleCollapsed(path) {
  if (state.collapsed.has(path)) state.collapsed.delete(path);
  else state.collapsed.add(path);
  render();
}

/** 侧栏树的一行（递归带上展开的子节点） */
function renderNode(node, depth) {
  const open = !state.collapsed.has(node.path);
  const hasChildren = node.children.length > 0;
  const row = h(
    'button',
    {
      class: `side-item${depth ? ' child' : ''}${state.active === node.path ? ' active' : ''}`,
      style: { paddingLeft: `${10 + depth * 16}px` },
      title: node.path,
      onClick: () => select(node.path),
    },
    hasChildren
      ? h('span', { class: `twisty${open ? '' : ' collapsed'}`, role: 'button', 'aria-label': open ? '收起' : '展开', onClick: (e) => (e.stopPropagation(), toggleCollapsed(node.path)) }, icon('chevronDown', 12))
      : h('span', { class: 'twisty none' }),
    icon(hasChildren ? 'folder' : 'image', 15),
    h('span', { class: 'label' }, node.name),
    h('span', { class: 'count num' }, node.count),
  );
  return [row, ...(open ? node.children.flatMap((c) => renderNode(c, depth + 1)) : [])];
}

function breadcrumb(node) {
  const segs = node.path.split(' / ');
  if (segs.length < 2) return null;
  const items = [];
  segs.slice(0, -1).forEach((seg, i) => {
    const p = segs.slice(0, i + 1).join(' / ');
    items.push(h('button', { onClick: () => select(p) }, seg), h('span', {}, '/'));
  });
  return h('div', { class: 'breadcrumb' }, ...items, h('span', {}, segs[segs.length - 1]));
}

function subscriptionBox(title, url, extra) {
  return h(
    'div',
    { class: 'sub-box' },
    h('div', { class: 'title' }, icon('link', 14), title),
    h(
      'div',
      { class: 'url-box' },
      h('input', { class: 'input', value: url, readonly: true, onClick: (e) => e.target.select() }),
      h('button', { class: 'btn', onClick: () => copyText(url).then(() => toast('已复制订阅地址', 'success')) }, icon('copy'), '复制'),
      extra ?? null,
    ),
  );
}

function render() {
  $('#top-actions').replaceChildren(
    h('a', { class: 'btn ghost sm', href: '/', target: '_blank' }, '查看首页'),
    h('button', { class: 'btn sm', onClick: importZip, title: '上传桌面应用“导出”生成的 zip，名称、标签、分类层级都会带上' }, icon('upload', 14), h('span', { class: 'label' }, '导入 zip')),
    h('button', { class: 'btn sm', onClick: siteSettings }, icon('settings', 14), h('span', { class: 'label' }, '站点设置')),
    h('button', { class: 'btn ghost sm', onClick: logout }, icon('logout', 14), h('span', { class: 'label' }, '退出')),
  );

  const node = state.active !== null ? state.tree.byPath.get(state.active) : null;
  const side = h(
    'aside',
    { class: 'side' },
    h('div', { class: 'side-head' }, h('span', {}, `表情包 ${state.packs.length}`), h('button', { class: 'btn ghost sm', title: '新建表情包', onClick: () => newPack('') }, icon('plus', 14))),
    ...state.tree.root.children.flatMap((n) => renderNode(n, 0)),
    state.packs.length === 0 ? h('div', { class: 'hint', style: { padding: '6px' } }, '还没有表情包，点 + 新建，或用右上角「导入 zip」。') : null,
  );

  let main;
  if (!node) {
    main = h('div', { class: 'empty' }, h('h3', {}, '新建一个表情包开始上传'), h('p', {}, '或者把桌面应用导出的 zip 直接导入，分类层级会原样保留。'), h('button', { class: 'btn primary', onClick: () => newPack('') }, icon('plus'), '新建表情包'));
  } else {
    const pack = node.pack;
    const hasChildren = node.children.length > 0;
    const descendants = countPacks(node) - (pack ? 1 : 0);
    const siblings = pack ? state.packs.filter((p) => p.group === pack.group) : [];
    const idx = pack ? siblings.findIndex((p) => p.id === pack.id) : -1;
    const sel = state.selection.size;

    const actions = h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn sm', title: '在这个分类下新建表情包', onClick: () => newPack(node.path) }, icon('plus', 14), '子表情包'),
      pack ? h('button', { class: 'btn sm', onClick: () => editPack(pack) }, '编辑') : null,
      pack ? h('button', { class: 'btn sm', title: '在同级里上移', disabled: idx <= 0, onClick: () => api(`/api/packs/${pack.id}/move`, { method: 'POST', body: { direction: 'up' } }).then(refresh) }, icon('arrowUp', 14)) : null,
      pack ? h('button', { class: 'btn sm', title: '在同级里下移', disabled: idx >= siblings.length - 1, onClick: () => api(`/api/packs/${pack.id}/move`, { method: 'POST', body: { direction: 'down' } }).then(refresh) }, icon('arrowDown', 14)) : null,
      pack ? h('a', { class: 'btn sm', href: `/packs/${pack.id}.zip`, title: '只打包这个表情包' }, icon('download', 14), 'zip') : null,
      pack ? h('button', { class: 'btn sm danger', onClick: () => deletePack(pack) }, icon('trash', 14), '删除') : null,
    );

    const boxes = [];
    if (hasChildren) {
      boxes.push(
        subscriptionBox(
          `订阅整个分组“${node.name}”：含 ${descendants} 个子表情包、共 ${node.count} 个表情，订阅后在应用里是同样的分类层级`,
          groupManifestUrl(node.path),
          h('a', { class: 'btn', href: groupZipUrl(node.path), title: '把这个分组连同子表情包打包下载' }, icon('download'), 'zip'),
        ),
      );
    }
    if (pack) boxes.push(subscriptionBox(hasChildren ? `只订阅“${node.name}”这一个表情包（不含子表情包）` : '订阅地址', `${location.origin}/packs/${pack.id}/manifest.json`));

    const dropzone = pack
      ? h(
          'div',
          { class: 'dropzone', onClick: () => pickFiles('image/*').then((files) => files.length && uploadFiles(pack, files)) },
          state.uploading ? `正在上传 ${state.uploading.done} / ${state.uploading.total}…` : '把图片拖到这里，或点击选择（支持 png / jpg / gif / webp，可多选）',
          state.uploading ? h('div', { class: 'progress' }, h('div', { style: { width: `${(100 * state.uploading.done) / state.uploading.total}%` } })) : null,
        )
      : null;
    if (dropzone) {
      for (const ev of ['dragenter', 'dragover']) dropzone.addEventListener(ev, (e) => (e.preventDefault(), dropzone.classList.add('over')));
      for (const ev of ['dragleave', 'drop']) dropzone.addEventListener(ev, (e) => (e.preventDefault(), dropzone.classList.remove('over')));
      dropzone.addEventListener('drop', (e) => uploadFiles(pack, e.dataTransfer.files));
    }

    const info = h(
      'div',
      { class: 'panel' },
      h(
        'div',
        { class: 'row', style: { justifyContent: 'space-between', alignItems: 'flex-start' } },
        h(
          'div',
          { style: { minWidth: 0 } },
          breadcrumb(node),
          h('h2', { style: { margin: 0 } }, icon(hasChildren ? 'folder' : 'image', 18), ' ', node.name, ' ', h('span', { class: 'hint num' }, pack ? `${pack.stickers.length} 个${hasChildren ? `，连同子表情包共 ${node.count} 个` : ''}` : `分组 · ${descendants} 个表情包 · ${node.count} 个表情`)),
        ),
        actions,
      ),
      pack?.description ? h('p', { class: 'hint', style: { margin: '6px 0 0' } }, pack.description) : null,
      pack?.tags.length ? h('p', { class: 'hint', style: { margin: '4px 0 0' } }, '包级标签：', pack.tags.map((t) => '#' + t).join(' ')) : null,
      ...boxes,
      hasChildren
        ? h(
            'div',
            { class: 'field', style: { marginTop: '10px' } },
            h('label', {}, '下面的表情包'),
            h('div', { class: 'child-list' }, ...node.children.map((c) => h('button', { class: 'btn sm', onClick: () => select(c.path) }, icon(c.children.length ? 'folder' : 'image', 14), c.name, h('span', { class: 'count num hint' }, c.count)))),
          )
        : null,
      dropzone ? h('div', { style: { marginTop: '12px' } }, dropzone) : null,
    );

    const grid = pack
      ? h(
          'div',
          { class: 'panel' },
          h(
            'div',
            { class: 'row', style: { marginBottom: '10px' } },
            sel ? h('span', {}, `已选 ${sel} 个`) : h('span', { class: 'hint' }, '点击选择表情；点名称改名，右键改标签'),
            h('span', { class: 'spacer' }),
            sel ? h('button', { class: 'btn sm', onClick: () => moveSelected(pack) }, icon('folder', 14), '移到其他包') : null,
            sel ? h('button', { class: 'btn sm danger', onClick: deleteSelected }, icon('trash', 14), '删除') : null,
            sel ? h('button', { class: 'btn sm ghost', onClick: () => (state.selection.clear(), render()) }, '取消') : null,
            h('button', { class: 'btn sm ghost', onClick: () => ((state.selection = new Set(pack.stickers.map((s) => s.id))), render()) }, '全选'),
          ),
          pack.stickers.length ? h('div', { class: `grid${sel ? ' selecting' : ''}` }, ...pack.stickers.map(stickerCard)) : h('div', { class: 'empty' }, '还没有表情，拖图片到上面上传。'),
        )
      : h('div', { class: 'panel' }, h('div', { class: 'empty' }, '这是一个分组，本身没有表情。订阅它的地址会把下面所有表情包一起带上；要上传图片请选择某个表情包，或点「子表情包」新建一个。'));

    main = h('div', { class: 'main' }, info, grid);
  }
  $('#app').replaceChildren(h('div', { class: 'admin' }, side, main));
}

boot();
export { formatBytes };
