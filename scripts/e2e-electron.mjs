// 端到端测试：启动真实的 Electron，通过 Chrome DevTools 协议驱动界面。
// 流程：导入 → 添加订阅（单包 + 多包）→ 搜索/标签筛选 → 点击复制 → 收藏 → 右键菜单 → 截图
//       → 关闭窗口（验证关闭前落盘）→ 重新启动（验证数据持久化与图片显示）
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSampleServer } from './serve-samples.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333;
const SAMPLE_PORT = 8788;
const args = new Set(process.argv.slice(2));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
function assertEq(name, actual, expected) {
  check(name, actual === expected, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}
async function waitForFile(p, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(p)) return true;
    await sleep(100);
  }
  return existsSync(p);
}

// ---------------------------------------------------------------- CDP 客户端

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
    // 连接断开（比如 Browser.close 之后）时，让所有等待中的请求结束，不要挂死
    ws.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('调试连接已关闭'));
      this.pending.clear();
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('无法连接调试端口')), { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** 在页面里执行代码；expression 可以是返回 Promise 的表达式 */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  }
  async waitFor(expression, timeoutMs = 15000, label = expression) {
    const t0 = Date.now();
    for (;;) {
      let v;
      try {
        v = await this.eval(expression);
      } catch {
        v = undefined;
      }
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时：${label}`);
      await sleep(150);
    }
  }
  close() {
    this.ws.close();
  }
}

/** 找到主窗口（无 hash）或浮窗（#float）的页面 */
async function findPage(role = 'main') {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find(
        (t) => t.type === 'page' && t.url.startsWith('app://') && (role === 'float') === t.url.endsWith('#float'),
      );
      if (page) return page;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() - t0 > 30000) throw new Error(`Electron ${role === 'float' ? '浮窗' : '主窗口'} 30 秒内没有出现`);
    await sleep(250);
  }
}

// ---------------------------------------------------------------- 启动 / 关闭

function launch(dataDir) {
  // E2E_ELECTRON_BIN 可以指向打包后的可执行文件，用同一套测试验证安装包
  const electronPath = process.env.E2E_ELECTRON_BIN || require('electron');
  const env = { ...process.env, EMOJI_USER_DATA_DIR: dataDir };
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, logs, exited };
}

async function closeApp(cdp, proc) {
  // 走托盘菜单“退出”的同一条路（app.quit），验证最小化到托盘开启时也能正常退出并落盘
  await Promise.race([cdp.eval('window.emojiBridge.quit()').catch(() => undefined), sleep(3000)]);
  cdp.close();
  const code = await Promise.race([proc.exited, sleep(10000).then(() => 'timeout')]);
  if (code === 'timeout') {
    proc.child.kill();
    throw new Error('应用 10 秒内没有退出');
  }
  return code;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!args.has('--no-build')) {
    console.log('构建中…');
    execFileSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit', shell: true });
  }
  if (!existsSync(path.join(ROOT, 'examples', 'subscription', 'pack.json'))) {
    execFileSync(process.execPath, ['scripts/make-samples.mjs'], { cwd: ROOT, stdio: 'inherit' });
  }

  const { server, url: sampleUrl } = await createSampleServer(SAMPLE_PORT);
  const dataDir = path.join(ROOT, '.e2e-tmp', String(Date.now()));
  mkdirSync(dataDir, { recursive: true });
  console.log(`数据目录：${dataDir}`);
  console.log(`示例订阅源：${sampleUrl}`);

  let proc = launch(dataDir);
  try {
    // ---- 第一次启动
    let page = await findPage();
    let cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.waitFor('window.__emojiStore && window.__emojiStore.getState().loaded', 20000, '资料加载完成');
    console.log('\n第一次启动');
    const platformKind = await cdp.eval('document.title');
    check('窗口标题', platformKind === '表情包管理器', platformKind);

    // 导入本地图片（两次，第二次应被去重）
    const png = readFileSync(path.join(ROOT, 'examples', 'subscription', 'images', 'cat-happy.png')).toString('base64');
    const importExpr = (name) =>
      `(() => { const b = Uint8Array.from(atob('${png}'), c => c.charCodeAt(0));
         return window.__emojiStore.getState().importFiles([{ name: '${name}', bytes: b }], null); })()`;
    const imp1 = await cdp.eval(importExpr('本地导入.png'));
    assertEq('导入本地图片', imp1.added, 1);
    const imp2 = await cdp.eval(importExpr('重复的.png'));
    assertEq('重复图片被跳过', imp2.skipped, 1);

    // 订阅：单包
    const sub1 = await cdp.eval(`window.__emojiStore.getState().addSubscription('${sampleUrl}/pack.json')`);
    assertEq('单包订阅：新增表情数', sub1.result.added, 8);
    assertEq('单包订阅：失败数', sub1.result.failed, 0);
    assertEq('单包订阅：名称', sub1.subscription.name, '示例：猫猫表情包');

    // 订阅：多包（内联 + 引用）
    const sub2 = await cdp.eval(`window.__emojiStore.getState().addSubscription('${sampleUrl}/index.json')`);
    assertEq('多包订阅：新增表情数', sub2.result.added, 13);
    assertEq('多包订阅：包数', sub2.result.packs, 2);

    const state = await cdp.eval(
      `(() => { const s = window.__emojiStore.getState(); return { stickers: s.stickers.length, categories: s.categories.map(c => c.name).sort(), subs: s.subscriptions.length,
         tagged: s.stickers.filter(x => x.tags.includes('猫')).length, gifs: s.stickers.filter(x => x.ext === 'gif').length,
         tree: s.categories.map(c => [c.name, s.categories.find(p => p.id === c.parentId)?.name ?? null]) }; })()`,
    );
    assertEq('表情总数', state.stickers, 22);
    assertEq('分类', JSON.stringify(state.categories), JSON.stringify(['狗狗', '猫猫', '示例：猫猫表情包', '示例：表情合集'].sort()));
    // 多包订阅：订阅名是一级分类，两个包是它的二级分类
    const parentOf = (name) => state.tree.find((t) => t[0] === name)?.[1];
    check('多包订阅的包成为二级分类', parentOf('猫猫') === '示例：表情合集' && parentOf('狗狗') === '示例：表情合集', JSON.stringify(state.tree));
    check('单包订阅是一级分类', parentOf('示例：猫猫表情包') === null);
    assertEq('包级标签已合并到表情', state.tagged, 16);
    assertEq('GIF 保留了格式', state.gifs, 6);

    // 再次导入内容相同的图片并指定分类：不重复添加，而是把已有的那个移到该分类（保留名字）
    const catForDup = await cdp.eval("window.__emojiStore.getState().categories.find(c => c.name === '猫猫').id");
    const dupMove = await cdp.eval(`(() => { const b = Uint8Array.from(atob('${png}'), c => c.charCodeAt(0));
      return window.__emojiStore.getState().importFiles([{ name: '又拖进来一次.png', bytes: b }], '${catForDup}'); })()`);
    check('相同图片再次导入到分类 → 移动而非重复', dupMove.moved === 1 && dupMove.added === 0 && dupMove.skipped === 0, JSON.stringify(dupMove));
    const movedLocal = await cdp.eval("(() => { const s = window.__emojiStore.getState(); const x = s.stickers.find(t => t.source.type === 'local'); return { cat: x.categoryId, name: x.name, n: s.stickers.length }; })()");
    check('已有表情被移到新分类且名字不变', movedLocal.cat === catForDup && movedLocal.name === '本地导入' && movedLocal.n === 22, JSON.stringify(movedLocal));
    const dupSkip = await cdp.eval(`(() => { const b = Uint8Array.from(atob('${png}'), c => c.charCodeAt(0));
      return window.__emojiStore.getState().importFiles([{ name: 'x.png', bytes: b }], null); })()`);
    check('未指定分类时相同图片仍然跳过', dupSkip.skipped === 1 && dupSkip.moved === 0, JSON.stringify(dupSkip));
    await cdp.eval("(() => { const s = window.__emojiStore.getState(); s.setCategoryFor([s.stickers.find(t => t.source.type === 'local').id], null); })()");

    // 重复添加同一地址应报错
    const dup = await cdp.eval(
      `window.__emojiStore.getState().addSubscription('${sampleUrl}/pack.json').then(() => 'ok', e => e.message)`,
    );
    check('重复订阅被拒绝', /已经添加过/.test(dup), dup);

    // 无效地址：添加失败且不留下记录
    const bad = await cdp.eval(
      `window.__emojiStore.getState().addSubscription('${sampleUrl}/nope.json').then(() => 'ok', e => e.message)`,
    );
    check('404 订阅报错', /404/.test(bad), bad);
    assertEq('失败的订阅不保留', await cdp.eval('window.__emojiStore.getState().subscriptions.length'), 2);

    // 界面：网格数量、图片真的渲染出来了（sticker:// 协议）
    await cdp.waitFor("document.querySelectorAll('.card').length === 22", 10000, '网格显示 22 个表情');
    check('网格显示全部表情', true);
    const natural = await cdp.waitFor(
      "(() => { const img = document.querySelector('.card img'); return img && img.complete && img.naturalWidth; })()",
      10000,
      '图片加载',
    );
    check('图片通过 sticker:// 协议加载', natural === 160, String(natural));

    // 搜索与标签筛选
    await cdp.eval("window.__uiStore.getState().setQuery('汪')");
    await cdp.waitFor("document.querySelectorAll('.card').length === 5", 5000, '搜索 汪 → 5 个');
    check('搜索过滤', true);
    await cdp.eval("window.__uiStore.getState().setQuery('')");
    await cdp.eval("window.__uiStore.getState().toggleTag('开心')");
    await cdp.waitFor("document.querySelectorAll('.card').length === 3", 5000, '标签 开心 → 3 个');
    check('标签筛选', true);
    await cdp.eval('window.__uiStore.getState().clearTags()');
    await cdp.waitFor("document.querySelectorAll('.card').length === 22", 5000, '清除筛选');

    // 点击复制 → 盖章
    await cdp.eval("document.querySelector('.card').click()");
    const stamp = await cdp.waitFor(
      "Object.values(window.__uiStore.getState().stamps).includes('done')",
      8000,
      '出现“已复制”盖章',
    ).catch(() => false);
    const errToast = await cdp.eval("window.__uiStore.getState().toasts.filter(t => t.kind === 'error' && /复制失败/.test(t.message)).map(t => t.message).join('; ')");
    check('点击复制到剪贴板', !!stamp && !errToast, errToast || 'ok');

    // 收藏 + 右键菜单
    const firstId = await cdp.eval('window.__emojiStore.getState().stickers[0].id');
    await cdp.eval(`window.__emojiStore.getState().toggleFavorite('${firstId}')`);
    await cdp.waitFor("document.querySelectorAll('.fav-tab').length === 1", 5000, '收藏角标');
    check('收藏角标显示', true);
    await cdp.eval(
      "document.querySelector('.card').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))",
    );
    const menuItems = await cdp.waitFor("document.querySelectorAll('.menu [role=menuitem]').length", 5000, '右键菜单');
    check('右键菜单弹出', menuItems >= 6, `${menuItems} 项`);
    await cdp.eval("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");

    // 多选 + 批量加标签
    await cdp.eval(
      "(() => { const ui = window.__uiStore.getState(); const ids = window.__emojiStore.getState().stickers.slice(0, 3).map(s => s.id); ui.select(ids, 'replace'); window.__emojiStore.getState().addTagsTo(ids, ['测试标签']); ui.clearSelection(); })()",
    );
    assertEq('批量添加标签', await cdp.eval("window.__emojiStore.getState().stickers.filter(s => s.tags.includes('测试标签')).length"), 3);

    // ---- 名称显示与就地改名
    console.log('\n名称 / 改名');
    assertEq('每个表情下方显示名称', await cdp.eval("document.querySelectorAll('.card .name').length"), 22);
    // “全部”视图里标出所属分类（一级 / 二级）；进入分类视图后不再显示
    const catLabels = await cdp.eval("[...new Set(Array.from(document.querySelectorAll('.card .cat')).map(e => e.textContent))].sort()");
    // 一行显示“名称 / 分类”，分类只显示最末一级（完整路径在提示里）
    assertEq('全部视图标出所属分类', JSON.stringify(catLabels), JSON.stringify(['未分类', '示例：猫猫表情包', '狗狗', '猫猫'].sort()));
    const oneLine = await cdp.eval("(() => { const row = document.querySelector('.card .name-row'); const n = row.querySelector('.name').getBoundingClientRect(); const c = row.querySelector('.cat').getBoundingClientRect(); return { sameLine: Math.abs(n.top - c.top) < 4, title: row.querySelector('.cat').title }; })()");
    check('名称与分类在同一行', oneLine.sameLine, JSON.stringify(oneLine));
    await cdp.eval("window.__uiStore.getState().setView({ kind: 'category', id: window.__emojiStore.getState().categories.find(c => c.name === '狗狗').id })");
    await cdp.waitFor("document.querySelectorAll('.card').length === 5", 5000, '狗狗分类');
    assertEq('二级分类视图里不显示分类标签', await cdp.eval("document.querySelectorAll('.card .cat').length"), 0);
    // 一级分类的“全部”页签：标出每个表情所在的二级分类
    await cdp.eval("window.__uiStore.getState().setView({ kind: 'category', id: window.__emojiStore.getState().categories.find(c => c.name === '示例：表情合集').id })");
    await cdp.waitFor("document.querySelectorAll('.card').length === 13", 5000, '一级分类全部页签');
    const subLabels = await cdp.eval("Array.from(document.querySelectorAll('.card .cat')).map(e => e.textContent)");
    check('一级分类的全部页签里标出二级分类', subLabels.length === 13 && subLabels.filter((t) => t === '猫猫').length === 8 && subLabels.filter((t) => t === '狗狗').length === 5, JSON.stringify(subLabels));
    // 直接放在一级分类里的表情：标“未分类”，并出现在顶部的“未分类”页签里
    const parentCatId = await cdp.eval("window.__emojiStore.getState().categories.find(c => c.name === '示例：表情合集').id");
    const localId = await cdp.eval("window.__emojiStore.getState().stickers.find(s => s.source.type === 'local').id");
    await cdp.eval(`window.__emojiStore.getState().setCategoryFor(['${localId}'], '${parentCatId}')`);
    await cdp.waitFor("Array.from(document.querySelectorAll('.card .cat')).some(e => e.textContent === '未分类') ? 1 : 0", 5000, '未分类标记');
    check('直接放在一级分类里的表情标“未分类”', true);
    const ownTab = await cdp.eval("(() => { const t = Array.from(document.querySelectorAll('.subtabs [role=tab]')); const own = t.find(b => b.querySelector('.label').textContent === '未分类'); return { labels: t.map(b => b.querySelector('.label').textContent), count: own?.querySelector('.count')?.textContent }; })()");
    check('一级分类顶部有“未分类”页签且计数正确', ownTab.labels.includes('未分类') && ownTab.count === '1', JSON.stringify(ownTab));
    await cdp.eval("Array.from(document.querySelectorAll('.subtabs [role=tab]')).find(b => b.querySelector('.label').textContent === '未分类').click()");
    await cdp.waitFor("document.querySelectorAll('.card').length === 1", 5000, '未分类页签只显示直接放在一级分类里的表情');
    check('“未分类”页签只显示直接放在一级分类里的表情', (await cdp.eval("document.querySelectorAll('.card .cat').length")) === 0);
    assertEq('“未分类”页签高亮', await cdp.eval("document.querySelector('.subtabs [role=tab][aria-selected=true] .label').textContent"), '未分类');
    check('侧栏一级分类仍然高亮', (await cdp.eval("document.querySelector('.sidebar .side-item.active .label')?.textContent")) === '示例：表情合集');
    await cdp.eval(`window.__emojiStore.getState().setCategoryFor(['${localId}'], null)`);
    await cdp.eval("window.__uiStore.getState().setView({ kind: 'all' })");
    await cdp.waitFor("document.querySelectorAll('.card').length === 22", 5000, '回到全部');
    // 在“全部”里拖入 / 粘贴图片：先问放到哪个分类；在分类里则直接放进当前分类
    await cdp.eval(`(() => { const f = new File([Uint8Array.from(atob('${png}'), c => c.charCodeAt(0))], 'drop.png', { type: 'image/png' }); window.__emojiActions.importImages([f]); })()`);
    await cdp.waitFor("document.querySelector('.dialog h3')?.textContent.includes('放到哪个分类') ? 1 : 0", 3000, '询问分类的对话框');
    check('在“全部”里导入散图时询问分类', true);
    assertEq('对话框列出二级分类', await cdp.eval("document.querySelectorAll('.pick-list button.child').length"), 2);
    await cdp.eval('window.__uiStore.getState().closeDialog()');
    const renameId = await cdp.eval("window.__emojiStore.getState().stickers.find(s => s.name === '汪汪委屈').id");
    await cdp.eval(`window.__uiStore.getState().setRenaming('${renameId}')`);
    await cdp.waitFor("document.querySelector('.card .name-input') ? 1 : 0", 3000, '改名输入框');
    await cdp.eval(`(() => {
      const input = document.querySelector('.card .name-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '汪汪不委屈');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    assertEq('就地改名生效', await cdp.eval(`window.__emojiStore.getState().stickers.find(s => s.id === '${renameId}').name`), '汪汪不委屈');
    check('改名后输入框关闭', (await cdp.eval("document.querySelectorAll('.card .name-input').length")) === 0);
    await cdp.eval("(() => { const ids = window.__emojiStore.getState().stickers.filter(s => s.tags.includes('测试标签')).map(s => s.id); window.__emojiStore.getState().renameStickers(ids, '批量'); })()");
    assertEq('批量命名带序号', JSON.stringify(await cdp.eval("window.__emojiStore.getState().stickers.filter(s => s.tags.includes('测试标签')).map(s => s.name).sort()")), JSON.stringify(['批量 1', '批量 2', '批量 3']));

    // ---- 二级分类页签
    console.log('\n二级分类');
    const parentId = await cdp.eval("window.__emojiStore.getState().categories.find(c => c.name === '示例：表情合集').id");
    const catId = await cdp.eval("window.__emojiStore.getState().categories.find(c => c.name === '猫猫').id");
    await cdp.eval(`window.__uiStore.getState().setView({ kind: 'category', id: '${parentId}' })`);
    await cdp.waitFor("document.querySelectorAll('.card').length === 13", 5000, '一级分类包含二级分类里的 13 个表情');
    check('查看一级分类时包含二级分类的表情', true);
    const tabs = await cdp.eval("Array.from(document.querySelectorAll('.subtabs [role=tab] .label')).map(e => e.textContent)");
    assertEq('顶部页签', JSON.stringify(tabs), JSON.stringify(['全部', '猫猫', '狗狗', '未分类']));
    await cdp.eval("Array.from(document.querySelectorAll('.subtabs [role=tab]')).find(b => b.textContent.includes('猫猫')).click()");
    await cdp.waitFor("document.querySelectorAll('.card').length === 8", 5000, '点页签切到二级分类 → 8 个');
    check('点击页签切换二级分类', true);
    assertEq('页签高亮', await cdp.eval("document.querySelector('.subtabs [role=tab][aria-selected=true] .label').textContent"), '猫猫');
    assertEq('侧栏显示二级分类', await cdp.eval("document.querySelectorAll('.sidebar .side-item.child').length"), 2);
    // 手动建一个二级分类并移动表情进去
    const subId2 = await cdp.eval(`window.__emojiStore.getState().addCategory('番外', '${parentId}').id`);
    await cdp.eval(`window.__emojiStore.getState().setCategoryFor(['${renameId}'], '${subId2}')`);
    await cdp.eval(`window.__uiStore.getState().setView({ kind: 'category', id: '${parentId}' })`);
    await cdp.waitFor("document.querySelectorAll('.subtabs [role=tab]').length === 5", 5000, '新页签出现（全部 / 猫猫 / 狗狗 / 番外 / 未分类）');
    check('新建二级分类出现在页签', true);
    // 任意多级：在二级分类下再建三级
    const third = await cdp.eval(`(() => { try { const c = window.__emojiStore.getState().addCategory('三级', '${subId2}'); return c.parentId === '${subId2}' ? 'ok' : 'wrong parent'; } catch (e) { return e.message; } })()`);
    check('允许第三级分类', third === 'ok', third);
    await cdp.eval(`window.__uiStore.getState().setView({ kind: 'category', id: window.__emojiStore.getState().categories.find(c => c.name === '三级').id })`);
    await sleep(200);
    const crumbs = await cdp.eval("Array.from(document.querySelectorAll('.filterbar .crumb')).map(b => b.textContent)");
    assertEq('三级分类视图显示面包屑', JSON.stringify(crumbs), JSON.stringify(['示例：表情合集']));
    assertEq('三级分类没有子分类时页签列出同级', JSON.stringify(await cdp.eval("Array.from(document.querySelectorAll('.subtabs [role=tab] .label')).map(e => e.textContent)")), JSON.stringify(['全部', '三级', '未分类']));
    await cdp.eval(`window.__uiStore.getState().setView({ kind: 'all' })`);
    await cdp.waitFor("document.querySelectorAll('.card').length === 22", 5000, '回到全部');

    // ---- 框选多选（真实鼠标事件）
    console.log('\n框选');
    await cdp.eval('window.__uiStore.getState().clearSelection()');
    // 用小网格让 22 个表情都在可视区域内，避免拖动时自动滚动影响坐标
    await cdp.eval("window.__emojiStore.getState().updateSettings({ gridSize: 'small' })");
    await cdp.waitFor("document.querySelector('.grid[data-size=small]') ? 1 : 0", 3000, '小网格');
    await sleep(200);
    const geo = await cdp.eval(`(() => {
      const scroll = document.querySelector('.grid-scroll').getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll('.card')).map(c => c.getBoundingClientRect());
      const first = cards[0], last = cards[cards.length - 1];
      return { scroll: { left: scroll.left, right: scroll.right, top: scroll.top, bottom: scroll.bottom }, first: { left: first.left, top: first.top, bottom: first.bottom }, last: { bottom: last.bottom } };
    })()`);
    const drag = async (x1, y1, x2, y2) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / 6, y: y1 + ((y2 - y1) * i) / 6, button: 'left', buttons: 1 });
        await sleep(30);
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(150);
    };
    const expectedIn = (x1, y1, x2, y2) =>
      cdp.eval(`Array.from(document.querySelectorAll('.card')).filter(c => { const r = c.getBoundingClientRect(); return r.left < ${x2} && r.right > ${x1} && r.top < ${y2} && r.bottom > ${y1}; }).length`);
    // 起点放在左侧内边距（永远是空白，且不受底部多选条出现影响），从最后一行拖到右上角：应框住全部
    const startX = geo.scroll.left + 5;
    const startY = geo.last.bottom - 2;
    await drag(startX, startY, geo.scroll.right - 30, geo.first.top + 6);
    const sel1 = await cdp.eval('window.__uiStore.getState().selection.size');
    const exp1 = await expectedIn(startX, geo.first.top + 6, geo.scroll.right - 30, startY);
    check('拖动框选选中覆盖到的表情', sel1 === exp1 && sel1 > 1, `选中 ${sel1}，框内 ${exp1}`);
    check('框选结束后没有残留的框', (await cdp.eval("document.querySelectorAll('.marquee').length")) === 0);
    // 只框第一行
    await cdp.eval('window.__uiStore.getState().clearSelection()');
    const rowY = geo.first.bottom + 3;
    await drag(startX, rowY, geo.scroll.right - 30, geo.first.top + 6);
    const sel2 = await cdp.eval('window.__uiStore.getState().selection.size');
    const exp2 = await expectedIn(startX, geo.first.top + 6, geo.scroll.right - 30, rowY);
    check('只框住第一行', sel2 === exp2 && sel2 < sel1, `选中 ${sel2}，框内 ${exp2}`);
    // 点击空白处取消选择
    await sleep(350);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: geo.first.top + 6, button: 'left', buttons: 1, clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX, y: geo.first.top + 6, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(100);
    assertEq('点击空白处取消选择', await cdp.eval('window.__uiStore.getState().selection.size'), 0);
    await cdp.eval("window.__emojiStore.getState().updateSettings({ gridSize: 'medium' })");

    // ---- 批量复制（多个文件一起放进剪贴板）
    console.log('\n批量复制');
    const threeIds = await cdp.eval("window.__emojiStore.getState().stickers.slice(0, 3).map(s => s.id)");
    await cdp.eval(`window.__uiStore.getState().select(${JSON.stringify(threeIds)}, 'replace')`);
    await cdp.eval(`window.__emojiActions.copyManyWithFeedback(${JSON.stringify(threeIds)})`);
    const bulkToast = await cdp.waitFor("window.__uiStore.getState().toasts.map(t => t.kind + ':' + t.message).find(m => /复制/.test(m)) || ''", 10000, '批量复制提示').catch(() => '');
    check('批量复制 3 个文件到剪贴板', /^success:已复制 3 个/.test(bulkToast), bulkToast);
    check('批量复制后记录了使用', (await cdp.eval('Object.keys(window.__emojiStore.getState().usage).length')) >= 3);
    await cdp.eval('window.__uiStore.getState().clearSelection()');

    // ---- 导出 → 删除 → 导入：名称、标签、分类都还原
    console.log('\n导出 / 导入');
    // 用“狗狗”里的表情：它们的图片在本地没有重复，导入时不会被按内容去重跳过
    const dogCatId = await cdp.eval("window.__emojiStore.getState().categories.find(c => c.name === '狗狗').id");
    const exportIds = await cdp.eval("window.__emojiStore.getState().stickers.filter(s => s.categoryId === '" + dogCatId + "').slice(0, 3).map(s => s.id)");
    const before = await cdp.eval(`window.__emojiStore.getState().stickers.filter(s => ${JSON.stringify(exportIds)}.includes(s.id)).map(s => ({ name: s.name, tags: s.tags, cat: s.categoryId }))`);
    const exportCount = await cdp.eval(`window.__emojiStore.getState().exportPackage(${JSON.stringify(exportIds)}, '测试导出').then(r => { window.__pkg = r.bytes; return r.count; })`);
    assertEq('导出 3 个表情', exportCount, 3);
    check('zip 大小合理', (await cdp.eval('window.__pkg.length')) > 2000);
    await cdp.eval(`window.__emojiStore.getState().deleteStickers(${JSON.stringify(exportIds)})`);
    assertEq('删除后表情数', await cdp.eval('window.__emojiStore.getState().stickers.length'), 19);
    const imp = await cdp.eval('window.__emojiStore.getState().importPackage(window.__pkg)');
    check('导入压缩包', imp.added === 3 && imp.failed === 0 && imp.missing === 0, JSON.stringify(imp));
    assertEq('导入没有重复建分类', imp.categoriesCreated, 0);
    const restored = await cdp.eval(`window.__emojiStore.getState().stickers.filter(s => s.source.type === 'local' && s.categoryId === '${dogCatId}').map(s => ({ name: s.name, tags: s.tags, cat: s.categoryId }))`);
    const key = (x) => `${x.name}|${x.tags.join(',')}|${x.cat}`;
    check('名称、标签、分类全部还原', JSON.stringify(restored.map(key).sort()) === JSON.stringify(before.map(key).sort()), JSON.stringify(restored));
    assertEq('还原后表情数', await cdp.eval('window.__emojiStore.getState().stickers.length'), 22);

    // ---- 导入文件夹：文件夹名成为分类，子文件夹成为二级分类
    console.log('\n导入文件夹');
    const b64 = (f) => readFileSync(path.join(ROOT, 'examples', 'subscription', 'images', f)).toString('base64');
    // 用还没有以本地方式导入过的图片，免得被按内容去重
    await cdp.eval(`window.__mkFolderFile = (b64, name, rel) => { const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)); return { name, rel, size: bytes.length, read: async () => bytes }; }`);
    const folderResult = await cdp.eval(`(() => {
      const folder = { name: '测试文件夹', files: [
        window.__mkFolderFile('${b64('cat-angry.png')}', 'angry.png', '可爱/angry.png'),
        window.__mkFolderFile('${b64('cat-sleepy.png')}', 'sleepy.png', '难过/sleepy.png'),
        window.__mkFolderFile('${b64('cat-neutral.png')}', 'wow.png', 'wow.png'),
        window.__mkFolderFile('${b64('cat-neutral.png')}', 'notes.txt', 'notes.txt'),
      ] };
      return window.__emojiActions.importFolders([folder], { addToCategory: true, names: ['测试文件夹'], placement: { kind: 'top' }, subfoldersAsChildren: true, targetCategoryId: null });
    })()`);
    check('文件夹导入 3 张（非图片被忽略）', folderResult.added === 3, JSON.stringify(folderResult));
    assertEq('文件夹与子文件夹成为分类', JSON.stringify(folderResult.categoryNames), JSON.stringify(['测试文件夹', '测试文件夹 / 可爱', '测试文件夹 / 难过']));
    const folderTree = await cdp.eval(`(() => { const s = window.__emojiStore.getState(); const p = s.categories.find(c => c.name === '测试文件夹'); const kids = s.categories.filter(c => c.parentId === p.id).map(c => c.name).sort(); const inRoot = s.stickers.filter(x => x.categoryId === p.id).map(x => x.name); return { kids, inRoot }; })()`);
    check('子文件夹是二级分类，根目录图片在一级分类里', JSON.stringify(folderTree) === JSON.stringify({ kids: ['可爱', '难过'], inRoot: ['wow'] }), JSON.stringify(folderTree));

    // 多个文件夹一起导入到某个一级分类下，各自成为二级分类（名称可改；子文件夹合并进来）
    const multiResult = await cdp.eval(`(() => {
      const p = window.__emojiStore.getState().categories.find(c => c.name === '测试文件夹');
      const folders = [
        { name: 'wink', files: [window.__mkFolderFile('${b64('cat-wink.png')}', 'wink.png', 'deep/wink.png')] },
        { name: 'love', files: [window.__mkFolderFile('${b64('cat-love.gif')}', 'love.gif', 'love.gif')] },
      ];
      return window.__emojiActions.importFolders(folders, { addToCategory: true, names: ['眨眼包', 'love'], placement: { kind: 'under', parentId: p.id }, subfoldersAsChildren: true, targetCategoryId: null });
    })()`);
    check('多文件夹导入到一级分类下', multiResult.added === 2 && multiResult.failed === 0, JSON.stringify(multiResult));
    assertEq('各自成为子分类（名称已改），子文件夹再成为下一级', JSON.stringify(multiResult.categoryNames), JSON.stringify(['测试文件夹 / 眨眼包', '测试文件夹 / 眨眼包 / deep', '测试文件夹 / love']));
    const multiTree = await cdp.eval(`(() => { const s = window.__emojiStore.getState(); const p = s.categories.find(c => c.name === '测试文件夹'); const kids = s.categories.filter(c => c.parentId === p.id).map(c => c.name).sort(); const wink = s.categories.find(c => c.name === '眨眼包'); const deep = s.categories.find(c => c.name === 'deep'); return { kids, deepParent: deep ? s.categories.find(c => c.id === deep.parentId)?.name : null, deepCount: s.stickers.filter(x => x.categoryId === deep?.id).length, winkDirect: s.stickers.filter(x => x.categoryId === wink?.id).length }; })()`);
    check('子文件夹逐级成为子分类（第三级）', JSON.stringify(multiTree) === JSON.stringify({ kids: ['love', '可爱', '眨眼包', '难过'], deepParent: '眨眼包', deepCount: 1, winkDirect: 0 }), JSON.stringify(multiTree));
    // 右键“导出这个分类”要包含所有层级的子分类里的表情
    const exportCheck = await cdp.eval(`(() => {
      const s = window.__emojiStore.getState();
      const root = s.categories.find(c => c.name === '测试文件夹');
      const ids = new Set([root.id]);
      let grew = true;
      while (grew) { grew = false; for (const c of s.categories) if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) { ids.add(c.id); grew = true; } }
      const expected = s.stickers.filter(x => x.categoryId && ids.has(x.categoryId)).length;
      window.__emojiActions.exportCategory(root.id);
      const d = window.__uiStore.getState().dialog;
      window.__uiStore.getState().closeDialog();
      return { expected, got: d.kind === 'exportPackage' ? d.ids.length : -1, levels: ids.size };
    })()`);
    check('导出分类包含所有层级的子分类', exportCheck.got === exportCheck.expected && exportCheck.levels >= 3, JSON.stringify(exportCheck));

    // 新建一级分类并把多个文件夹放在它下面
    const newParentResult = await cdp.eval(`(() => {
      const folders = [{ name: '甲', files: [window.__mkFolderFile('${b64('cat-surprised.png')}', 'z.png', 'z.png')] }];
      return window.__emojiActions.importFolders(folders, { addToCategory: true, names: ['甲'], placement: { kind: 'newParent', name: '新建父分类' }, subfoldersAsChildren: false, targetCategoryId: null });
    })()`);
    const newParentTree = await cdp.eval(`(() => { const s = window.__emojiStore.getState(); const p = s.categories.find(c => c.name === '新建父分类'); return { top: !!p && !p.parentId, child: !!s.categories.find(c => c.name === '甲' && c.parentId === p?.id), added: ${JSON.stringify('x')} }; })()`);
    check('新建一级分类并放入文件夹', newParentResult.added === 1 && newParentTree.top && newParentTree.child, JSON.stringify({ newParentResult, newParentTree }));
    // ---- 侧栏拖拽：调整顺序、变成二级 / 一级
    console.log('\n分类拖拽');
    await cdp.eval(`window.__dragCat = async (fromName, toName, where) => {
      const rows = Array.from(document.querySelectorAll('.sidebar .side-item')).filter(b => b.querySelector('.label'));
      const rowOf = (name) => rows.find(b => b.querySelector('.label').textContent === name);
      const src = rowOf(fromName), dst = rowOf(toName);
      if (!src || !dst) return { error: 'row not found: ' + (src ? toName : fromName) };
      const dt = new DataTransfer();
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      await wait(50);
      const r = dst.getBoundingClientRect();
      const y = where === 'into' ? r.top + r.height / 2 : where === 'before' ? r.top + 2 : r.bottom - 2;
      dst.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientY: y, clientX: r.left + 10 }));
      await wait(50);
      const cls = dst.className;
      dst.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientY: y, clientX: r.left + 10 }));
      src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      await wait(100);
      const s = window.__emojiStore.getState();
      const me = s.categories.find(c => c.name === fromName);
      const sorted = [...s.categories].sort((a, b) => a.order - b.order);
      return { cls, parent: s.categories.find(c => c.id === me.parentId)?.name ?? null,
        siblings: sorted.filter(c => (c.parentId ?? null) === (me.parentId ?? null)).map(c => c.name) };
    }`);
    const d1 = await cdp.eval("window.__dragCat('番外', '测试文件夹', 'into')");
    check('拖到一级分类上 → 变成它的二级分类', d1.parent === '测试文件夹' && /drop-into/.test(d1.cls), JSON.stringify(d1));
    const d2 = await cdp.eval("window.__dragCat('番外', '示例：猫猫表情包', 'before')");
    check('拖到一级分类之间 → 变成一级分类并排在前面', d2.parent === null && d2.siblings[0] === '番外' && /drop-before/.test(d2.cls), JSON.stringify(d2));
    const d3 = await cdp.eval("window.__dragCat('测试文件夹', '示例：猫猫表情包', 'after')");
    check('一级分类之间拖动调整顺序', d3.parent === null && d3.siblings.indexOf('测试文件夹') === d3.siblings.indexOf('示例：猫猫表情包') + 1, JSON.stringify(d3));
    const d4 = await cdp.eval("window.__dragCat('可爱', '难过', 'after')");
    check('二级分类之间拖动调整顺序', d4.parent === '测试文件夹' && d4.siblings.indexOf('可爱') === d4.siblings.indexOf('难过') + 1, JSON.stringify(d4));
    const d5 = await cdp.eval("window.__dragCat('猫猫', '测试文件夹', 'into')");
    check('订阅里的表情包分类不能拖走', d5.parent === '示例：表情合集' && !/drop-into/.test(d5.cls), JSON.stringify(d5));
    const d6 = await cdp.eval("window.__dragCat('示例：表情合集', '猫猫', 'into')");
    check('不能拖到自己的子分类下面（成环）', d6.parent === null && !/drop-into/.test(d6.cls), JSON.stringify(d6));
    const d7 = await cdp.eval("window.__dragCat('新建父分类', '测试文件夹', 'into')");
    check('带子分类的分类可以整棵拖到别的分类下', d7.parent === '测试文件夹' && /drop-into/.test(d7.cls), JSON.stringify(d7));
    const d7tree = await cdp.eval("(() => { const s = window.__emojiStore.getState(); const jia = s.categories.find(c => c.name === '甲'); const p = s.categories.find(c => c.id === jia.parentId); const gp = s.categories.find(c => c.id === p?.parentId); return [p?.name, gp?.name]; })()");
    assertEq('子分类跟着一起移动，成为第三级', JSON.stringify(d7tree), JSON.stringify(['新建父分类', '测试文件夹']));

    // ---- 更新提示对话框（用一份假的发布信息渲染）
    console.log('\n更新提示');
    await cdp.eval(`window.__uiStore.getState().openDialog({ kind: 'update', current: '1.0.0', release: { version: '9.9.9', tag: 'v9.9.9', name: '测试', notes: '## 新增\\n- 测试条目', url: 'https://example.com/rel', assets: [{ name: 'Emoji Manager-9.9.9-win-x64.exe', url: 'https://example.com/a.exe', size: 1024 }] } })`);
    await cdp.waitFor("document.querySelector('.dialog h3')?.textContent.includes('发现新版本 9.9.9') ? 1 : 0", 3000, '更新对话框');
    check('更新对话框显示版本号', true);
    check('更新说明已转成纯文本', (await cdp.eval("document.querySelector('.dialog .notes')?.textContent")) === '新增\n• 测试条目');
    check('按系统挑出了 Windows 安装包', /a\\.exe|1\\.0 KB|1024/.test(await cdp.eval("document.querySelector('.dialog .meta')?.textContent")) || (await cdp.eval("document.querySelector('.dialog .btn.primary')?.textContent")).includes('下载'));
    await cdp.eval("Array.from(document.querySelectorAll('.dialog footer button')).find(b => b.textContent.includes('跳过')).click()");
    assertEq('跳过这个版本被记住', await cdp.eval('window.__emojiStore.getState().settings.skippedVersion'), '9.9.9');
    await cdp.eval("window.__emojiStore.getState().updateSettings({ skippedVersion: '' })");

    // ---- 协议链接：第二个实例带着 emojimanager://subscribe?url=… 启动 → 第一个实例弹出确认
    console.log('\n协议链接');
    const deepUrl = `${sampleUrl}/dogs.json`;
    const second = spawn(process.env.E2E_ELECTRON_BIN || require('electron'), ['.', `emojimanager://subscribe?url=${encodeURIComponent(deepUrl)}`], {
      cwd: ROOT,
      env: { ...process.env, EMOJI_USER_DATA_DIR: dataDir },
      stdio: 'ignore',
    });
    const secondExit = new Promise((resolve) => second.on('exit', resolve));
    const deepDialog = await cdp.waitFor("document.querySelector('.dialog h3')?.textContent === '添加订阅？' ? document.querySelector('.dialog p')?.textContent : ''", 15000, '协议链接确认对话框').catch(() => '');
    check('第二个实例把链接交给第一个实例并弹出确认', deepDialog.includes(deepUrl), deepDialog.slice(0, 80));
    check('第二个实例自己退出了', (await Promise.race([secondExit.then(() => 'exited'), sleep(8000).then(() => 'timeout')])) === 'exited');
    await cdp.eval("Array.from(document.querySelectorAll('.dialog footer button')).find(b => b.textContent.includes('取消')).click()");
    assertEq('取消后没有新增订阅', await cdp.eval('window.__emojiStore.getState().subscriptions.length'), 2);


    // ---- 缩略图与动图播放
    console.log('\n缩略图 / 动图');
    await cdp.eval("window.__uiStore.getState().clearSelection(); window.__uiStore.getState().setView({ kind: 'all' })");
    const thumbsReady = await cdp.waitFor("(() => { const s = window.__emojiStore.getState(); return s.stickers.filter(x => x.ext === 'gif' && x.thumb).length >= 6 ? 1 : 0; })()", 40000, 'GIF 缩略图生成完成').catch(() => 0);
    check('后台为动图生成了缩略图', thumbsReady === 1);
    const thumbDir = path.join(dataDir, 'library', 'thumbs');
    check('缩略图文件已写入 thumbs/', existsSync(thumbDir) && readdirSync(thumbDir).filter((f) => f.endsWith('.webp')).length >= 6);
    const gifSrc = (re) => `(() => { const s = window.__emojiStore.getState(); const gif = s.stickers.find(x => x.ext === 'gif' && x.thumb); const img = document.querySelector('.card[data-id="' + gif.id + '"] img'); return img && ${re}.test(decodeURIComponent(img.getAttribute('src'))) ? 1 : 0; })()`;
    await cdp.eval("window.__emojiStore.getState().updateSettings({ gridAnimation: 'hover' })");
    await cdp.waitFor(gifSrc('/thumbs[/]/'), 5000, '悬停模式显示缩略图');
    check('悬停模式下 GIF 显示缩略图', true);
    await cdp.eval("window.__emojiStore.getState().updateSettings({ gridAnimation: 'always' })");
    await cdp.waitFor(gifSrc('/[.]gif$/'), 5000, '全部播放模式显示原图');
    check('全部播放模式下 GIF 显示原图', true);
    assertEq('筛选条的动图按钮显示为暂停', await cdp.eval("document.querySelector('.anim-toggle')?.getAttribute('aria-label')"), '暂停网格里的动图');
    await cdp.eval("document.querySelector('.anim-toggle').click()");
    assertEq('点按钮切换为悬停播放', await cdp.eval('window.__emojiStore.getState().settings.gridAnimation'), 'hover');
    await cdp.eval("window.__emojiStore.getState().updateSettings({ gridAnimation: 'auto' })");

    // ---- 双击展开 / 收起
    console.log('\n双击折叠');
    const childVisible = () => cdp.eval("Array.from(document.querySelectorAll('.sidebar .side-item.child')).map(b => b.querySelector('.label').textContent).includes('可爱')");
    const dbl = () => cdp.eval(`(() => { const row = Array.from(document.querySelectorAll('.sidebar .side-item')).find(b => b.querySelector('.label')?.textContent === '测试文件夹'); row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()`);
    const beforeDbl = await childVisible();
    await dbl();
    await sleep(100);
    const afterDbl = await childVisible();
    check('双击分类收起子分类', beforeDbl === true && afterDbl === false, `${beforeDbl} -> ${afterDbl}`);
    await dbl();
    await sleep(100);
    check('再次双击展开子分类', (await childVisible()) === true);

    // ---- 批量改名对话框
    console.log('\n批量改名');
    const rnIds = await cdp.eval("window.__emojiStore.getState().stickers.filter(s => s.tags.includes('测试标签')).map(s => s.id)");
    await cdp.eval(`window.__uiStore.getState().openDialog({ kind: 'bulkRename', ids: ${JSON.stringify(rnIds)} })`);
    await cdp.waitFor("document.querySelector('.dialog h3')?.textContent.includes('批量改名') ? 1 : 0", 3000, '批量改名对话框');
    assertEq('对话框列出所选表情', await cdp.eval("document.querySelectorAll('.rename-row').length"), rnIds.length);
    await cdp.eval("Array.from(document.querySelectorAll('.dialog .segmented button')).find(b => b.textContent === '查找替换').click()");
    await cdp.eval(`(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const f = document.getElementById('rn-find'); setter.call(f, '批量'); f.dispatchEvent(new Event('input', { bubbles: true })); const r = document.getElementById('rn-replace'); setter.call(r, '喵'); r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await cdp.waitFor("document.querySelectorAll('.rename-row.changed').length === 3 ? 1 : 0", 3000, '预览显示 3 个改动');
    check('查找替换实时预览', true);
    await cdp.eval("Array.from(document.querySelectorAll('.dialog footer button')).find(b => b.textContent.trim() === '改名').click()");
    assertEq('批量改名生效', JSON.stringify(await cdp.eval("window.__emojiStore.getState().stickers.filter(s => s.tags.includes('测试标签')).map(s => s.name).sort()")), JSON.stringify(['喵 1', '喵 2', '喵 3']));

    const totalAfterImports = await cdp.eval('window.__emojiStore.getState().stickers.length');
    const catsAfterImports = await cdp.eval('window.__emojiStore.getState().categories.length');
    const nestedBefore = await cdp.eval("window.__emojiStore.getState().categories.filter(c => c.parentId).length");
    await cdp.eval("window.__uiStore.getState().setView({ kind: 'all' })");
    await cdp.waitFor(`document.querySelectorAll('.card').length === ${totalAfterImports}`, 5000, '网格刷新');

    // 截图：浅色、深色、打开订阅对话框
    const screenshot = async (name) => {
      await sleep(400);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const shotPath = path.join(ROOT, '.e2e-tmp', name);
      writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
      console.log(`  截图：${shotPath}`);
    };
    await screenshot('screenshot.png');
    await cdp.eval("window.__emojiStore.getState().updateSettings({ theme: 'dark' })");
    await cdp.eval("window.__uiStore.getState().openDialog({ kind: 'subscriptions' })");
    await screenshot('screenshot-dark-subscriptions.png');
    await cdp.eval('window.__uiStore.getState().closeDialog()');
    await cdp.eval("window.__emojiStore.getState().updateSettings({ theme: 'system' })");

    // ---- 桌面浮窗
    console.log('\n浮窗');
    // “最近使用”只算还存在的表情（批量复制过的里面可能有后来被删掉又导入回来的）
    const usageMain = await cdp.eval('(() => { const s = window.__emojiStore.getState(); return s.stickers.filter(x => s.usage[x.id]).length; })()');
    check('主窗口复制后有使用记录', usageMain >= 1, String(usageMain));
    await cdp.eval('window.emojiBridge.showFloat()');
    const floatPage = await findPage('float');
    const fcdp = await Cdp.connect(floatPage.webSocketDebuggerUrl);
    await fcdp.waitFor('window.__emojiStore && window.__emojiStore.getState().loaded', 20000, '浮窗资料加载完成');
    assertEq('浮窗识别自己的角色', await fcdp.eval('document.documentElement.dataset.window'), 'float');
    assertEq('浮窗读到同一份资料', await fcdp.eval('window.__emojiStore.getState().stickers.length'), totalAfterImports);
    assertEq('浮窗是只读窗口', await fcdp.eval('window.__emojiStore.getState().saveBlocked'), true);
    await fcdp.waitFor("document.querySelector('.float .search input') === document.activeElement", 5000, '浮窗搜索框聚焦');
    check('呼出后搜索框自动聚焦', true);
    // 默认显示“最近”：主窗口里复制过的那些
    await fcdp.waitFor(`document.querySelectorAll('.float-grid .card').length === ${usageMain}`, 5000, `浮窗最近使用 ${usageMain} 个`);
    check('浮窗默认显示最近使用', true);
    assertEq('“最近”标签页高亮', await fcdp.eval("document.querySelector('.float-tabs .chip.active .label')?.textContent"), '最近');

    // 输入即在全部表情中搜索，Enter 复制焦点项，未固定时复制后自动隐藏
    await fcdp.eval(`(() => {
      const input = document.querySelector('.float .search input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '汪');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await fcdp.waitFor("document.querySelectorAll('.float-grid .card').length === 5", 5000, '浮窗搜索 汪 → 5 个');
    check('浮窗搜索全部表情', true);
    const focusedName = await fcdp.eval("document.querySelector('.float-grid .card.selected')?.getAttribute('aria-label')");
    check('第一项有键盘焦点框', !!focusedName, focusedName);
    const focusedId = await fcdp.eval(
      `window.__emojiStore.getState().stickers.find(s => s.name === ${JSON.stringify(focusedName)})?.id`,
    );
    const beforeCopy = Date.now();
    await fcdp.eval(`document.querySelector('.float .search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
    const floatStamp = await fcdp.waitFor("Object.values(window.__uiStore.getState().stamps).includes('done')", 8000, '浮窗盖章').catch(() => false);
    check('Enter 复制焦点表情', !!floatStamp);
    const usageSynced = await cdp
      .waitFor(`(window.__emojiStore.getState().usage[${JSON.stringify(focusedId)}]?.last ?? 0) >= ${beforeCopy} ? 1 : 0`, 5000, '主窗口收到使用记录')
      .catch(() => 0);
    check('浮窗的使用记录同步到主窗口', usageSynced === 1);
    check('使用记录已落盘', await waitForFile(path.join(dataDir, 'library', 'usage.json'), 3000));
    const hiddenAfterCopy = await fcdp.waitFor('document.visibilityState === "hidden" ? 1 : 0', 5000, '浮窗复制后隐藏').catch(() => 0);
    check('未固定时复制后自动隐藏', hiddenAfterCopy === 1);

    // 主窗口改名 → 浮窗自动重新读取
    const renamedId = await cdp.eval("window.__emojiStore.getState().stickers.find(s => s.name === '汪？').id");
    await cdp.eval(`window.__emojiStore.getState().updateSticker('${renamedId}', { name: '浮窗同步测试' })`);
    const synced = await fcdp.waitFor(`window.__emojiStore.getState().stickers.some(s => s.id === '${renamedId}' && s.name === '浮窗同步测试')`, 8000, '浮窗同步改名').catch(() => false);
    check('主窗口修改后浮窗自动刷新', !!synced);

    // 再次呼出 → 搜索框被清空；Esc 隐藏
    await cdp.eval('window.emojiBridge.showFloat()');
    await fcdp.waitFor('document.visibilityState === "visible"', 5000, '浮窗再次显示');
    await sleep(100);
    assertEq('再次呼出时搜索框已清空', await fcdp.eval("document.querySelector('.float .search input').value"), '');
    await fcdp.eval("document.querySelector('.float .search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    const hiddenByEsc = await fcdp.waitFor('document.visibilityState === "hidden" ? 1 : 0', 5000, 'Esc 隐藏').catch(() => 0);
    check('Esc 隐藏浮窗', hiddenByEsc === 1);
    // 浮窗截图（先显示出来）
    await cdp.eval('window.emojiBridge.showFloat()');
    await fcdp.waitFor('document.visibilityState === "visible"', 5000, '浮窗显示');
    await sleep(300);
    const fshot = await fcdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(ROOT, '.e2e-tmp', 'screenshot-float.png'), Buffer.from(fshot.data, 'base64'));
    console.log(`  截图：${path.join(ROOT, '.e2e-tmp', 'screenshot-float.png')}`);
    await cdp.eval('window.emojiBridge.hideFloat()');
    fcdp.close();

    // 快捷键设置能到达主进程：写法不合法（Electron 会把它解析成裸的 Z 键）必须被拒绝
    await cdp.eval("window.__emojiStore.getState().updateSettings({ floatHotkey: 'NotAKey+Z' })");
    const badHotkey = await cdp.waitFor('window.__emojiStore.getState().hotkeyOk === false ? 1 : 0', 5000, '无效快捷键被报告').catch(() => 0);
    check('不合法的快捷键被拒绝', badHotkey === 1);
    await cdp.eval("window.__emojiStore.getState().updateSettings({ floatHotkey: 'Z' })");
    await sleep(300);
    check('没有修饰键的快捷键被拒绝', (await cdp.eval('window.__emojiStore.getState().hotkeyOk')) === false);
    // 一个几乎不会被别的程序占用的组合
    await cdp.eval("window.__emojiStore.getState().updateSettings({ floatHotkey: 'CommandOrControl+Alt+Shift+F12' })");
    const goodHotkey = await cdp.waitFor('window.__emojiStore.getState().hotkeyOk === true ? 1 : 0', 5000, '快捷键恢复').catch(() => 0);
    check('有效快捷键注册成功', goodHotkey === 1);
    await cdp.eval("window.__emojiStore.getState().updateSettings({ floatHotkey: 'Alt+Shift+E' })");

    // 立刻关闭：此时最后的修改还没来得及落盘（300ms 防抖），验证关闭前会写完
    await cdp.eval(`window.__emojiStore.getState().updateSticker('${firstId}', { name: '关闭前改的名字' })`);
    const code = await closeApp(cdp, proc);
    check('应用正常退出', code === 0, `退出码 ${code}`);

    const libFile = path.join(dataDir, 'library', 'library.json');
    const lib = JSON.parse(readFileSync(libFile, 'utf8'));
    assertEq('library.json 里的表情数', lib.stickers.length, totalAfterImports);
    assertEq('library.json 里的订阅数', lib.subscriptions.length, 2);
    assertEq('library.json 里的分类数', lib.categories.length, catsAfterImports);
    check('关闭前的修改已保存', lib.stickers.some((s) => s.name === '关闭前改的名字'));
    check('备份文件存在', existsSync(libFile + '.bak'));
    check('窗口位置已记住', existsSync(path.join(dataDir, 'window-state.json')));

    // ---- 第二次启动：数据持久化
    console.log('\n第二次启动');
    proc = launch(dataDir);
    page = await findPage();
    cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.waitFor('window.__emojiStore && window.__emojiStore.getState().loaded', 20000, '资料加载完成');
    assertEq('重启后表情数', await cdp.eval('window.__emojiStore.getState().stickers.length'), totalAfterImports);
    assertEq('重启后收藏数', await cdp.eval('window.__emojiStore.getState().stickers.filter(s => s.favorite).length'), 1);
    assertEq('重启后多级分类结构仍在', await cdp.eval("window.__emojiStore.getState().categories.filter(c => c.parentId).length"), nestedBefore);
    await cdp.waitFor(`document.querySelectorAll('.card').length === ${totalAfterImports}`, 10000, '网格');
    const natural2 = await cdp.waitFor(
      "(() => { const img = document.querySelector('.card img'); return img && img.complete && img.naturalWidth; })()",
      10000,
      '图片加载',
    );
    check('重启后图片正常显示', natural2 === 160, String(natural2));
    // 启动时自动同步：等它跑完，应无变化、无错误
    await sleep(3000);
    const after = await cdp.eval(
      "(() => { const s = window.__emojiStore.getState(); return { n: s.stickers.length, errors: s.subscriptions.map(x => x.lastError).filter(Boolean), running: Object.values(s.syncStatus).some(x => x.running) }; })()",
    );
    check('启动自动同步无变化无错误', after.n === totalAfterImports && after.errors.length === 0 && !after.running, JSON.stringify(after));

    // 删除多包订阅并删除其表情：空掉的分类消失，还有本地表情的“猫猫”和它的父分类留下
    const subId = await cdp.eval('window.__emojiStore.getState().subscriptions[1].id');
    const subStickers = await cdp.eval(`window.__emojiStore.getState().stickers.filter(s => s.source.type === 'subscription' && s.source.subscriptionId === '${subId}').length`);
    await cdp.eval(`window.__emojiStore.getState().removeSubscription('${subId}', true)`);
    const afterRemove = await cdp.eval(
      '(() => { const s = window.__emojiStore.getState(); return { n: s.stickers.length, cats: s.categories.map(c => c.name).sort(), subs: s.subscriptions.length, linked: s.categories.filter(c => c.subscriptionId).length }; })()',
    );
    assertEq('删除多包订阅后表情数', afterRemove.n, totalAfterImports - subStickers);
    check('空掉的“猫猫”分类被删除', !afterRemove.cats.includes('猫猫'), JSON.stringify(afterRemove.cats));
    check('仍有本地表情的“狗狗”及其父分类保留', afterRemove.cats.includes('狗狗') && afterRemove.cats.includes('示例：表情合集'), JSON.stringify(afterRemove.cats));
    assertEq('保留的分类不再关联已删除的订阅', afterRemove.linked, 1);
    const code2 = await closeApp(cdp, proc);
    check('第二次正常退出', code2 === 0, `退出码 ${code2}`);
    const allLogs = proc.logs.join('');
    check('托盘图标已加载', !allLogs.includes('托盘图标缺失'));
    const errorLines = allLogs.split('\n').filter((l) => /\b(Error|Uncaught|TypeError)\b/.test(l) && !/DevTools/.test(l));
    check('主进程没有报错', errorLines.length === 0, errorLines.slice(0, 2).join(' | '));
  } catch (e) {
    failures++;
    console.error('\n测试中断：', e.message);
    console.error('--- Electron 输出 ---\n' + proc.logs.join('').slice(-4000));
    proc.child.kill();
  } finally {
    server.close();
  }

  console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
