import { $, h, icon, api, toast, dialog, confirmDialog, promptDialog, copyText, formatBytes } from './common.js';

const state = { admin: false, site: null, packs: [], active: null, selection: new Set(), uploading: null };
$('#brand-icon').append(icon('smile', 18));

async function refresh() {
  state.site = await api('/api/site');
  state.packs = state.site.packs;
  document.title = `管理 · ${state.site.title}`;
  $('#brand-title').textContent = state.site.title;
  if (state.active && !state.packs.some((p) => p.id === state.active)) state.active = null;
  if (!state.active && state.packs.length) state.active = state.packs[0].id;
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
async function newPack() {
  const name = await promptDialog({ title: '新建表情包', label: '名称', placeholder: '例如：猫猫', confirmText: '创建' });
  if (!name?.trim()) return;
  const p = await api('/api/packs', { method: 'POST', body: { name } });
  state.active = p.id;
  await refresh();
  toast(`已创建“${p.name}”`, 'success');
}

async function editPack(p) {
  const name = h('input', { class: 'input', value: p.name, maxlength: 80 });
  const desc = h('textarea', { class: 'input', placeholder: '可选，显示在表情包标题下方' }, p.description);
  const tags = h('input', { class: 'input', value: p.tags.join(', '), placeholder: '用逗号分隔，会加到这个包里的每个表情上' });
  const d = dialog({
    title: '编辑表情包',
    body: [
      h('div', { class: 'field' }, h('label', {}, '名称'), name),
      h('div', { class: 'field' }, h('label', {}, '说明'), desc),
      h('div', { class: 'field' }, h('label', {}, '包级标签'), tags),
    ],
    footer: [
      h('button', { class: 'btn', onClick: () => d.close() }, '取消'),
      h(
        'button',
        {
          class: 'btn primary',
          onClick: async () => {
            try {
              await api(`/api/packs/${p.id}`, { method: 'PATCH', body: { name: name.value, description: desc.value, tags: tags.value } });
              d.close();
              await refresh();
              toast('已保存', 'success');
            } catch (e) {
              toast(e.message, 'error');
            }
          },
        },
        '保存',
      ),
    ],
  });
}

async function deletePack(p) {
  const ok = await confirmDialog({ title: `删除表情包“${p.name}”？`, message: `里面的 ${p.stickers.length} 个表情和图片文件会一起删除，订阅了它的人下次同步时也会移除。`, confirmText: '删除', danger: true });
  if (!ok) return;
  await api(`/api/packs/${p.id}`, { method: 'DELETE' });
  state.active = null;
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
  toast(`正在上传 ${file.name}…`);
  const form = new FormData();
  form.append('file', file, file.name);
  try {
    const r = await api('/api/import', { method: 'POST', form });
    await refresh();
    toast(`已导入 ${r.added} 个表情到 ${r.names.length} 个表情包${r.packs ? `（新建 ${r.packs} 个）` : ''}${r.skipped ? `，跳过 ${r.skipped} 个重复` : ''}${r.missing ? `，${r.missing} 个缺少图片` : ''}`, 'success');
  } catch (e) {
    toast(`导入失败：${e.message}`, 'error');
  }
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

async function moveSelected() {
  const ids = Array.from(state.selection);
  const others = state.packs.filter((p) => p.id !== state.active);
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
              toast(`已移到“${p.name}”`, 'success');
            },
          },
          icon('folder'),
          p.name,
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
    h('div', { class: 'thumb' }, h('img', { src: s.url, alt: s.name, loading: 'lazy' })),
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
function render() {
  $('#top-actions').replaceChildren(
    h('a', { class: 'btn ghost sm', href: '/', target: '_blank' }, '查看首页'),
    h('button', { class: 'btn sm', onClick: importZip, title: '上传桌面应用“导出”生成的 zip，名称、标签、分类都会带上' }, icon('upload', 14), h('span', { class: 'label' }, '导入 zip')),
    h('button', { class: 'btn sm', onClick: siteSettings }, icon('settings', 14), h('span', { class: 'label' }, '站点设置')),
    h('button', { class: 'btn ghost sm', onClick: logout }, icon('logout', 14), h('span', { class: 'label' }, '退出')),
  );

  const pack = state.packs.find((p) => p.id === state.active);
  const side = h(
    'aside',
    { class: 'side' },
    h('div', { class: 'side-head' }, h('span', {}, `表情包 ${state.packs.length}`), h('button', { class: 'btn ghost sm', title: '新建表情包', onClick: newPack }, icon('plus', 14))),
    ...state.packs.map((p) =>
      h(
        'button',
        { class: `side-item${p.id === state.active ? ' active' : ''}`, onClick: () => ((state.active = p.id), state.selection.clear(), render()) },
        icon('folder', 15),
        h('span', { class: 'label' }, p.name),
        h('span', { class: 'count num' }, p.stickers.length),
      ),
    ),
    state.packs.length === 0 ? h('div', { class: 'hint', style: { padding: '6px' } }, '还没有表情包，点 + 新建，或用右上角「导入 zip」。') : null,
  );

  let main;
  if (!pack) {
    main = h('div', { class: 'empty' }, h('h3', {}, '新建一个表情包开始上传'), h('p', {}, '或者把桌面应用导出的 zip 直接导入。'), h('button', { class: 'btn primary', onClick: newPack }, icon('plus'), '新建表情包'));
  } else {
    const subUrl = `${location.origin}/packs/${pack.id}/manifest.json`;
    const sel = state.selection.size;
    const sorted = state.packs;
    const idx = sorted.findIndex((p) => p.id === pack.id);
    const dropzone = h(
      'div',
      { class: 'dropzone', onClick: () => pickFiles('image/*').then((files) => files.length && uploadFiles(pack, files)) },
      state.uploading ? `正在上传 ${state.uploading.done} / ${state.uploading.total}…` : '把图片拖到这里，或点击选择（支持 png / jpg / gif / webp，可多选）',
      state.uploading ? h('div', { class: 'progress' }, h('div', { style: { width: `${(100 * state.uploading.done) / state.uploading.total}%` } })) : null,
    );
    for (const ev of ['dragenter', 'dragover']) dropzone.addEventListener(ev, (e) => (e.preventDefault(), dropzone.classList.add('over')));
    for (const ev of ['dragleave', 'drop']) dropzone.addEventListener(ev, (e) => (e.preventDefault(), dropzone.classList.remove('over')));
    dropzone.addEventListener('drop', (e) => uploadFiles(pack, e.dataTransfer.files));

    main = h(
      'div',
      { class: 'main' },
      h(
        'div',
        { class: 'panel' },
        h(
          'div',
          { class: 'row', style: { justifyContent: 'space-between' } },
          h('h2', { style: { margin: 0 } }, pack.name, ' ', h('span', { class: 'hint num' }, `${pack.stickers.length} 个`)),
          h(
            'div',
            { class: 'row' },
            h('button', { class: 'btn sm', onClick: () => editPack(pack) }, '编辑'),
            h('button', { class: 'btn sm', disabled: idx <= 0, onClick: () => api(`/api/packs/${pack.id}/move`, { method: 'POST', body: { direction: 'up' } }).then(refresh) }, icon('arrowUp', 14)),
            h('button', { class: 'btn sm', disabled: idx >= sorted.length - 1, onClick: () => api(`/api/packs/${pack.id}/move`, { method: 'POST', body: { direction: 'down' } }).then(refresh) }, icon('arrowDown', 14)),
            h('a', { class: 'btn sm', href: `/packs/${pack.id}.zip` }, icon('download', 14), 'zip'),
            h('button', { class: 'btn sm danger', onClick: () => deletePack(pack) }, icon('trash', 14), '删除'),
          ),
        ),
        pack.description ? h('p', { class: 'hint', style: { margin: '6px 0 0' } }, pack.description) : null,
        pack.tags.length ? h('p', { class: 'hint', style: { margin: '4px 0 0' } }, '包级标签：', pack.tags.map((t) => '#' + t).join(' ')) : null,
        h(
          'div',
          { class: 'url-box', style: { marginTop: '10px' } },
          h('input', { class: 'input', value: subUrl, readonly: true, onClick: (e) => e.target.select() }),
          h('button', { class: 'btn', onClick: () => copyText(subUrl).then(() => toast('已复制订阅地址', 'success')) }, icon('copy'), '复制订阅地址'),
        ),
        h('div', { style: { marginTop: '12px' } }, dropzone),
      ),
      h(
        'div',
        { class: 'panel' },
        h(
          'div',
          { class: 'row', style: { marginBottom: '10px' } },
          sel ? h('span', {}, `已选 ${sel} 个`) : h('span', { class: 'hint' }, '点击选择表情；点名称改名，右键改标签'),
          h('span', { class: 'spacer' }),
          sel ? h('button', { class: 'btn sm', onClick: moveSelected }, icon('folder', 14), '移到其他包') : null,
          sel ? h('button', { class: 'btn sm danger', onClick: deleteSelected }, icon('trash', 14), '删除') : null,
          sel ? h('button', { class: 'btn sm ghost', onClick: () => (state.selection.clear(), render()) }, '取消') : null,
          h('button', { class: 'btn sm ghost', onClick: () => ((state.selection = new Set(pack.stickers.map((s) => s.id))), render()) }, '全选'),
        ),
        pack.stickers.length ? h('div', { class: `grid${sel ? ' selecting' : ''}` }, ...pack.stickers.map(stickerCard)) : h('div', { class: 'empty' }, '还没有表情，拖图片到上面上传。'),
      ),
    );
  }
  $('#app').replaceChildren(h('div', { class: 'admin' }, side, main));
}

boot();
export { formatBytes };
