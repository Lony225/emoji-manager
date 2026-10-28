// 端到端测试：启动真实的 Electron，通过 Chrome DevTools 协议驱动界面。
// 流程：导入 → 添加订阅（单包 + 多包）→ 搜索/标签筛选 → 点击复制 → 收藏 → 右键菜单 → 截图
//       → 关闭窗口（验证关闭前落盘）→ 重新启动（验证数据持久化与图片显示）
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSampleServer } from './serve-samples.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9333;
/** 局域网同步测试里第二个实例的调试端口 */
const PORT2 = 9334;
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
async function findPage(role = 'main', port = PORT) {
  const t0 = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
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

function launch(dataDir, extraEnv = {}, port = PORT) {
  // E2E_ELECTRON_BIN 可以指向打包后的可执行文件，用同一套测试验证安装包
  const electronPath = process.env.E2E_ELECTRON_BIN || require('electron');
  const env = { ...process.env, EMOJI_USER_DATA_DIR: dataDir, ...extraEnv };
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, ['.', `--remote-debugging-port=${port}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

  // 模板表情的素材从示例服务器拿（假清单），不联网
  const memeEnv = { EMOJI_MEME_RESOURCES_ROOT: `${sampleUrl}/meme-resources/` };
  let proc = launch(dataDir, memeEnv);
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
    // 全选按钮：筛选条上的「全选」选中当前显示的全部；选了一部分后底部多选条也有「全选」
    const visibleCount = await cdp.eval("document.querySelectorAll('.card').length");
    await cdp.eval("document.querySelector('.filterbar .select-all').click()");
    assertEq('筛选条「全选」选中当前显示的全部表情', await cdp.eval('window.__uiStore.getState().selection.size'), visibleCount);
    assertEq('全选后按钮变为「取消全选」', await cdp.eval("document.querySelector('.filterbar .select-all')?.textContent.trim()"), '取消全选');
    check('全选后多选条不再显示「全选」', (await cdp.eval("Array.from(document.querySelectorAll('.selectionbar .btn')).some(b => b.textContent.trim() === '全选')")) === false);
    await cdp.eval("document.querySelector('.filterbar .select-all').click()");
    assertEq('「取消全选」清空选择', await cdp.eval('window.__uiStore.getState().selection.size'), 0);
    await cdp.eval("window.__uiStore.getState().select([window.__emojiStore.getState().stickers[0].id], 'replace')");
    await cdp.waitFor("Array.from(document.querySelectorAll('.selectionbar .btn')).some(b => b.textContent.trim() === '全选') ? 1 : 0", 3000, '多选条出现「全选」');
    await cdp.eval("Array.from(document.querySelectorAll('.selectionbar .btn')).find(b => b.textContent.trim() === '全选').click()");
    assertEq('多选条「全选」选中全部', await cdp.eval('window.__uiStore.getState().selection.size'), visibleCount);
    await cdp.eval('window.__uiStore.getState().clearSelection()');
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
    await cdp.eval(`window.__uiStore.getState().openDialog({ kind: 'update', current: '1.0.0', release: { version: '9.9.9', tag: 'v9.9.9', name: '测试', notes: '## 新增\\n- **测试条目**：按 \`Ctrl+V\`\\n  - 子项\\n- 见 [文档](https://example.com/doc)', url: 'https://example.com/rel', assets: [{ name: 'Emoji Manager-9.9.9-win-x64.exe', url: 'https://example.com/a.exe', size: 1024 }] } })`);
    await cdp.waitFor("document.querySelector('.dialog h3')?.textContent.includes('发现新版本 9.9.9') ? 1 : 0", 3000, '更新对话框');
    check('更新对话框显示版本号', true);
    const notesDom = await cdp.eval("(() => { const n = document.querySelector('.dialog .notes'); return n ? { h2: n.querySelector('h2')?.textContent, items: n.querySelectorAll(':scope > ul > li').length, bold: n.querySelector('li strong')?.textContent, code: n.querySelector('code')?.textContent, sub: n.querySelector('li ul li')?.textContent, link: n.querySelector('a')?.getAttribute('href'), pre: !!n.closest('pre') } : null; })()");
    check('更新说明按 Markdown 结构渲染（标题 / 列表 / 加粗 / 代码 / 子列表 / 链接）', !!notesDom && notesDom.h2 === '新增' && notesDom.items === 2 && notesDom.bold === '测试条目' && notesDom.code === 'Ctrl+V' && notesDom.sub === '子项' && notesDom.link === 'https://example.com/doc' && !notesDom.pre, JSON.stringify(notesDom));
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
    // 订阅入口隐藏时（SUBSCRIPTIONS_ENABLED = false），链接只给一条提示；开放时弹出确认对话框
    const subsHidden = await cdp.eval("!document.querySelector('.topbar button[title=\"添加订阅\"]')");
    if (subsHidden) {
      const deepToast = await cdp.waitFor("window.__uiStore.getState().toasts.map(t => t.message).find(m => /订阅功能暂未开放/.test(m)) || ''", 15000, '协议链接提示').catch(() => '');
      check('订阅隐藏时协议链接只提示不处理', !!deepToast, deepToast);
    } else {
      const deepDialog = await cdp.waitFor("document.querySelector('.dialog h3')?.textContent === '添加订阅？' ? document.querySelector('.dialog p')?.textContent : ''", 15000, '协议链接确认对话框').catch(() => '');
      check('第二个实例把链接交给第一个实例并弹出确认', deepDialog.includes(deepUrl), deepDialog.slice(0, 80));
    }
    check('第二个实例自己退出了', (await Promise.race([secondExit.then(() => 'exited'), sleep(8000).then(() => 'timeout')])) === 'exited');
    if (!subsHidden) await cdp.eval("Array.from(document.querySelectorAll('.dialog footer button')).find(b => b.textContent.includes('取消')).click()");
    assertEq('取消后没有新增订阅', await cdp.eval('window.__emojiStore.getState().subscriptions.length'), 2);

    // ---- 订阅相关界面已隐藏
    if (subsHidden) {
      console.log('\n订阅入口隐藏');
      const hidden = await cdp.eval(`(() => ({
        sideHead: Array.from(document.querySelectorAll('.sidebar .side-head span')).some(e => e.textContent === '订阅'),
        topBtn: !!document.querySelector('.topbar button[title="添加订阅"]') || !!document.querySelector('.topbar button[title="同步全部订阅"]'),
        rssIcons: document.querySelectorAll('.sidebar .side-item .icon path[d^="M5 19"]').length,
      }))()`);
      check('侧栏没有“订阅”区、顶栏没有订阅按钮、分类不再显示订阅图标', !hidden.sideHead && !hidden.topBtn && hidden.rssIcons === 0, JSON.stringify(hidden));
      await cdp.eval("window.__uiStore.getState().openDialog({ kind: 'settings' })");
      await cdp.waitFor("document.querySelector('.dialog h3')?.textContent === '设置' ? 1 : 0", 3000, '设置对话框');
      check('设置里没有“启动时自动同步订阅”', (await cdp.eval("document.querySelector('.dialog')?.textContent.includes('自动同步订阅')")) === false);
      await cdp.eval('window.__uiStore.getState().closeDialog()');
      await cdp.eval("window.__uiStore.getState().openDialog({ kind: 'subscriptions' })");
      await sleep(200);
      check('订阅对话框不会打开', (await cdp.eval("document.querySelectorAll('.dialog').length")) === 0);
      await cdp.eval('window.__uiStore.getState().closeDialog()');
    }


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


    // ---- 粘贴 / 拖入
    console.log('\n粘贴 / 拖入');
    await cdp.eval("window.__uiStore.getState().setView({ kind: 'all' })");
    // 在页面里现画一张独一无二的 PNG（免得和已有表情按内容去重）
    await cdp.eval(`window.__e2ePng = async (color) => { const c = document.createElement('canvas'); c.width = 48; c.height = 48; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 48, 48); x.fillStyle = '#000'; x.fillRect(12, 12, 24, 24); const b = await new Promise((r) => c.toBlob(r, 'image/png')); return new Uint8Array(await b.arrayBuffer()); }`);
    // 1) “粘贴”按钮：图片先放进系统剪贴板，再由主进程触发粘贴命令 → 页面收到带图片的 paste 事件 → 在“全部”里先问放到哪个分类
    await cdp.eval("window.__e2ePng('#ff8800').then((b) => window.emojiBridge.copyImagePng(b))");
    await cdp.eval('window.__emojiActions.pasteFromClipboard()');
    const pasteAsk = await cdp.waitFor("document.querySelector('.dialog h3')?.textContent.includes('放到哪个分类') ? 1 : 0", 8000, '粘贴后询问分类').catch(() => 0);
    check('点“粘贴”后收到剪贴板里的图片并询问分类', pasteAsk === 1);
    await cdp.eval("Array.from(document.querySelectorAll('.pick-list button')).find((b) => b.textContent.trim() === '狗狗').click()");
    const pasted = await cdp.waitFor("(() => { const s = window.__emojiStore.getState(); const x = s.stickers.find((t) => t.name === '粘贴的表情 1'); return x ? JSON.stringify({ cat: s.categories.find((c) => c.id === x.categoryId)?.name, ext: x.ext }) : ''; })()", 8000, '粘贴的表情出现').catch(() => '');
    check('剪贴板图片存为表情并放进所选分类', !!pasted && JSON.parse(pasted).cat === '狗狗' && JSON.parse(pasted).ext === 'png', pasted);
    // 2) 在分类视图里粘贴：直接放进当前分类，不再询问
    await cdp.eval(`window.__uiStore.getState().setView({ kind: 'category', id: '${dogCatId}' })`);
    await cdp.eval("window.__e2ePng('#0088ff').then((b) => window.emojiBridge.copyImagePng(b))");
    await cdp.eval('window.__emojiActions.pasteFromClipboard()');
    const pasted2 = await cdp.waitFor(`(() => window.__emojiStore.getState().stickers.filter((t) => t.name.startsWith('粘贴的表情') && t.categoryId === '${dogCatId}').length === 2 ? 1 : 0)()`, 8000, '分类视图里粘贴直接放入').catch(() => 0);
    check('在分类里粘贴直接存进该分类', pasted2 === 1 && (await cdp.eval("document.querySelectorAll('.dialog').length")) === 0);
    // 3) 粘贴网页片段：<img src=…gif> → 由主进程下载原图，GIF 保留
    const gifUrl = `${sampleUrl}/images/cat-sad.gif`;
    await cdp.eval(`(() => { const dt = new DataTransfer(); dt.setData('text/html', '<meta charset="utf-8"><img src="${gifUrl}" alt="">'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    const fromHtml = await cdp.waitFor(`(() => { const x = window.__emojiStore.getState().stickers.find((t) => t.name === 'cat-sad' && t.source.type === 'local'); return x ? x.ext + ':' + (x.categoryId === '${dogCatId}') : ''; })()`, 15000, '网页图片下载导入').catch(() => '');
    assertEq('粘贴网页里的 <img> 会下载原图（GIF 保留动画格式）', fromHtml, 'gif:true');
    // 位图和 <img> 同时在剪贴板里（浏览器里“复制图片”就是这样）：优先抓原图而不是用位图
    await cdp.eval(`(async () => { const png = await window.__e2ePng('#22aa22'); const dt = new DataTransfer(); dt.items.add(new File([png], 'image.png', { type: 'image/png' })); dt.setData('text/html', '<img src="${sampleUrl}/images/dog-sleepy.gif">'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
    const preferOriginal = await cdp.waitFor("window.__emojiStore.getState().stickers.some((t) => t.name === 'dog-sleepy' && t.source.type === 'local' && t.ext === 'gif') ? 1 : 0", 15000, '优先原图').catch(() => 0);
    check('剪贴板里同时有位图和网页图片地址时优先下载原图', preferOriginal === 1 && (await cdp.eval("window.__emojiStore.getState().stickers.filter((t) => t.name.startsWith('粘贴的表情')).length")) === 2);
    // 没有图片的粘贴（纯文字）不处理也不报错
    await cdp.eval("(() => { const dt = new DataTransfer(); dt.setData('text/plain', '只是文字'); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()");
    await sleep(200);
    check('粘贴纯文字时不报错', (await cdp.eval("window.__uiStore.getState().toasts.filter((t) => t.kind === 'error').length")) === 0);
    // 4) 拖到侧栏分类上：覆盖层提示目标分类、分类行高亮，松开直接存进那个分类
    await cdp.eval("window.__uiStore.getState().setView({ kind: 'all' })");
    // 用“狗狗”当落点：它本来就有本地表情，不影响后面“删除订阅后空分类消失”的检查
    const catCatId = dogCatId;
    const dropInfo = await cdp.eval(`(async () => {
      const png = await window.__e2ePng('#aa22aa');
      const dt = new DataTransfer();
      dt.items.add(new File([png], '拖入测试.png', { type: 'image/png' }));
      const row = document.querySelector('.sidebar .side-item[data-drop-category="${catCatId}"]');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const fire = (type) => row.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      fire('dragenter');
      await wait(60);
      fire('dragover');
      await wait(60);
      const overlay = document.querySelector('.drop-overlay')?.textContent ?? '';
      const rowClass = row.className;
      fire('drop');
      await wait(60);
      return { overlay, rowClass, overlayAfter: !!document.querySelector('.drop-overlay') };
    })()`);
    check('拖到分类上时覆盖层提示目标分类、分类行高亮', /狗狗/.test(dropInfo.overlay) && /drop-into/.test(dropInfo.rowClass) && !dropInfo.overlayAfter, JSON.stringify(dropInfo));
    const dropped = await cdp.waitFor(`(() => { const x = window.__emojiStore.getState().stickers.find((t) => t.name === '拖入测试'); return x ? (x.categoryId === '${catCatId}' ? 'ok' : 'wrong') : ''; })()`, 8000, '拖入的表情').catch(() => '');
    check('图片拖到侧栏分类上直接存进该分类', dropped === 'ok', dropped);

    // ---- 制作表情（加文字）
    console.log('\n制作表情');
    const srcPng = await cdp.eval("(() => { const x = window.__emojiStore.getState().stickers.find((t) => t.name === '拖入测试'); return { id: x.id, categoryId: x.categoryId, hash: x.hash }; })()");
    await cdp.eval(`window.__emojiActions.openMaker({ type: 'sticker', id: '${srcPng.id}' })`);
    await cdp.waitFor("document.querySelector('.dialog.maker .maker-frame canvas') ? 1 : 0", 8000, '制作对话框加载图片');
    check('制作对话框打开并显示预览', true);
    check('没有文字时不能保存', await cdp.eval("document.querySelector('.maker-save').disabled"));
    await cdp.eval("(() => { const ta = document.querySelector('.maker-text'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '测试文字'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await sleep(150);
    const overlayDrawn = await cdp.eval("(() => { const c = document.querySelector('.maker-frame canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return { w: c.width, h: c.height, painted: n, name: document.getElementById('maker-name').value }; })()");
    check('文字层按原图尺寸绘制且画上了文字', overlayDrawn.w === 48 && overlayDrawn.h === 48 && overlayDrawn.painted > 20, JSON.stringify(overlayDrawn));
    assertEq('新表情名称默认用文字', overlayDrawn.name, '测试文字');
    // 用真实鼠标把文字从下方拖到上方 → 位置变成“自定义”
    const frameRect = await cdp.eval("(() => { const r = document.querySelector('.maker-frame').getBoundingClientRect(); return { x: r.left + r.width / 2, y1: r.top + r.height * 0.85, y2: r.top + r.height * 0.25 }; })()");
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: frameRect.x, y: frameRect.y1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: frameRect.x, y: frameRect.y1, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 4; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: frameRect.x, y: frameRect.y1 + ((frameRect.y2 - frameRect.y1) * i) / 4, button: 'left', buttons: 1 });
      await sleep(30);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: frameRect.x, y: frameRect.y2, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(100);
    const anchorNow = await cdp.eval("Array.from(document.querySelectorAll('.dialog.maker .segmented button.active')).map((b) => b.textContent)");
    check('拖动预览里的文字后位置变为“自定义”', anchorNow.includes('自定义'), JSON.stringify(anchorNow));
    const makerShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(ROOT, '.e2e-tmp', 'screenshot-maker.png'), Buffer.from(makerShot.data, 'base64'));
    await cdp.eval("document.querySelector('.maker-save').click()");
    const made = await cdp.waitFor("(() => { const x = window.__emojiStore.getState().stickers.find((t) => t.name === '测试文字'); return x ? JSON.stringify({ ext: x.ext, cat: x.categoryId, hash: x.hash }) : ''; })()", 15000, '生成的新表情').catch(() => '');
    check('保存为新表情（PNG，分类与来源相同，内容不同）', !!made && JSON.parse(made).ext === 'png' && JSON.parse(made).cat === srcPng.categoryId && JSON.parse(made).hash !== srcPng.hash, made);
    check('制作完成后对话框关闭', (await cdp.eval("document.querySelectorAll('.dialog').length")) === 0);
    const madeSize = await cdp.eval("(async () => { const s = window.__emojiStore.getState().stickers.find((t) => t.name === '测试文字'); if (!s) return [0, 0]; const i = new Image(); await new Promise((res, rej) => { i.onload = res; i.onerror = rej; i.src = 'sticker://library/' + s.file; }); return [i.naturalWidth, i.naturalHeight]; })()");
    assertEq('输出尺寸与原图一致', JSON.stringify(madeSize), JSON.stringify([48, 48]));
    // 动图：逐帧加字，重新编成 GIF
    const gifSticker = await cdp.eval("(() => { const x = window.__emojiStore.getState().stickers.find((t) => t.ext === 'gif' && t.source.type === 'local'); return x ? { id: x.id, file: x.file } : null; })()");
    check('有本地 GIF 可用于制作', !!gifSticker);
    const srcFrames = await cdp.eval(`(async () => { const r = await fetch('sticker://library/${gifSticker.file}'); const d = new ImageDecoder({ data: await r.arrayBuffer(), type: 'image/gif' }); await d.tracks.ready; await d.completed; const n = d.tracks.selectedTrack.frameCount; d.close(); return n; })()`);
    check('ImageDecoder 可用且原 GIF 是多帧', srcFrames > 1, String(srcFrames));
    await cdp.eval(`window.__emojiActions.openMaker({ type: 'sticker', id: '${gifSticker.id}' })`);
    await cdp.waitFor("document.querySelector('.dialog.maker .maker-frame canvas') && /动图/.test(document.querySelector('.dialog.maker footer .hint')?.textContent ?? '') ? 1 : 0", 8000, '制作对话框识别动图');
    check('识别为动图并提示输出 GIF', /GIF/.test(await cdp.eval("document.querySelector('.dialog.maker footer .hint').textContent")));
    await cdp.eval("(() => { const ta = document.querySelector('.maker-text'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(ta, '动图文字'); ta.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await cdp.eval("Array.from(document.querySelectorAll('.maker-presets .chip')).find((b) => b.textContent === '黄字黑边').click()");
    await sleep(100);
    await cdp.eval("document.querySelector('.maker-save').click()");
    const madeGif = await cdp.waitFor("(() => { const x = window.__emojiStore.getState().stickers.find((t) => t.name === '动图文字'); return x ? x.file : ''; })()", 60000, '生成的 GIF').catch(() => '');
    check('动图加字后保存为 GIF', /\.gif$/.test(madeGif), madeGif);
    const gifInfo = await cdp.eval(`(async () => { if (!'${madeGif}') return { head: '' }; const r = await fetch('sticker://library/${madeGif}'); const buf = await r.arrayBuffer(); const head = String.fromCharCode(...new Uint8Array(buf.slice(0, 6))); const d = new ImageDecoder({ data: buf, type: 'image/gif' }); await d.tracks.ready; await d.completed; const n = d.tracks.selectedTrack.frameCount; const { image } = await d.decode({ frameIndex: 0 }); const w = image.displayWidth, h = image.displayHeight; image.close(); d.close(); return { head, frames: n, w, h, bytes: buf.byteLength }; })()`);
    check('生成的 GIF 仍是多帧动画、尺寸不变', gifInfo.head === 'GIF89a' && gifInfo.frames > 1 && gifInfo.frames <= srcFrames && gifInfo.w === 160 && gifInfo.h === 160, JSON.stringify({ ...gifInfo, srcFrames }));

    // ---- 模板表情（meme-generator）：素材清单、字体、模板图片都来自本地示例服务器，不联网
    console.log('\n模板表情');
    await cdp.eval("window.__uiStore.getState().setView({ kind: 'all' })");
    await cdp.eval('window.__emojiActions.openMemeTemplates()');
    await cdp.waitFor("document.querySelector('.dialog.memes') ? 1 : 0", 5000, '模板对话框');
    const memeCount = await cdp.waitFor("document.querySelectorAll('.meme-card').length >= 250 ? document.querySelectorAll('.meme-card').length : 0", 40000, '模板列表').catch(() => 0);
    check('模板列表加载（引擎在工具进程里启动）', memeCount >= 250, String(memeCount));
    // 首次使用：提示下载字体（清单来自示例服务器，只有一个假字体）
    await cdp.waitFor("document.querySelector('.memes-banner .memes-download') ? 1 : 0", 15000, '下载字体提示');
    check('首次使用提示下载字体', true);
    await cdp.eval("document.querySelector('.memes-banner .memes-download').click()");
    await cdp.waitFor("!document.querySelector('.memes-banner') ? 1 : 0", 20000, '字体下载完成');
    const memeHome = path.join(dataDir, 'meme-generator');
    check('字体按清单下载并校验到数据目录', existsSync(path.join(memeHome, 'resources', 'fonts', 'sample.ttf')));
    // 搜索并选一个只要文字的模板：喜报
    const setSearch = (q) => cdp.eval(`(() => { const i = document.querySelector('.memes-toolbar input'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(i, ${JSON.stringify(q)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await setSearch('喜报');
    await cdp.waitFor("document.querySelector('.meme-card[data-key=good_news]') ? 1 : 0", 5000, '搜索到喜报');
    check('按关键词搜索模板', (await cdp.eval("document.querySelectorAll('.meme-card').length")) < 20);
    await cdp.eval("document.querySelector('.meme-card[data-key=good_news]').click()");
    await cdp.waitFor("document.querySelector('.meme-editor[data-key=good_news] .meme-text') ? 1 : 0", 5000, '喜报编辑面板');
    // 预览：模板图片按需从示例服务器下载后生成，并缓存到磁盘
    const previewOk = await cdp.waitFor("document.querySelector('.meme-card[data-key=good_news] img') ? 1 : 0", 30000, '喜报预览图').catch(() => 0);
    const previewCached = existsSync(path.join(memeHome, 'resources', 'images', 'good_news', '0.jpg')) && existsSync(path.join(memeHome, 'previews'));
    check('模板预览按需下载素材后生成，并缓存到磁盘', previewOk === 1 && previewCached, JSON.stringify({ previewOk, previewCached }));
    await cdp.eval(`(() => { const i = document.querySelector('.meme-editor .meme-text'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(i, '端到端测试'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await cdp.eval("document.querySelector('.meme-generate').click()");
    const newsResult = await cdp.waitFor("document.querySelector('.meme-result img') ? 1 : (document.querySelector('.meme-editor .error-text')?.textContent || 0)", 30000, '喜报生成结果').catch((e) => e.message);
    check('文字模板生成成功', newsResult === 1, String(newsResult));
    await cdp.eval("document.querySelector('.meme-copy')?.click()");
    const copyNews = await cdp.waitFor("window.__uiStore.getState().toasts.map((t) => t.kind + ':' + t.message).find((m) => /已复制|复制失败/.test(m)) || ''", 10000, '复制提示').catch(() => '');
    check('生成结果直接复制到剪贴板（PNG 按图片）', /^success:已复制图片/.test(copyNews), copyNews);
    await cdp.eval("document.querySelector('.meme-save')?.click()");
    const madeNews = await cdp.waitFor("(() => { const x = window.__emojiStore.getState().stickers.find((t) => t.name === '喜报 端到端测试'); return x ? x.ext : ''; })()", 10000, '喜报存为表情').catch(() => '');
    assertEq('生成结果保存为表情（PNG）', madeNews, 'png');
    // 图片模板：摸头（5 帧手 → GIF），图片从表情库里选
    await setSearch('摸');
    await cdp.waitFor("document.querySelector('.meme-card[data-key=petpet]') ? 1 : 0", 5000, '搜索到摸头');
    await cdp.eval("document.querySelector('.meme-card[data-key=petpet]').click()");
    await cdp.waitFor("document.querySelector('.meme-editor[data-key=petpet] .meme-add-image') ? 1 : 0", 5000, '摸头编辑面板');
    await cdp.eval("document.querySelector('.meme-add-image').click()");
    await cdp.waitFor("document.querySelectorAll('.meme-picker-grid button[data-id]').length > 5 ? 1 : 0", 5000, '表情库选图面板');
    await cdp.eval("document.querySelector('.meme-picker-grid button[data-id]').click()");
    await cdp.waitFor("document.querySelector('.meme-slot img') ? 1 : 0", 5000, '图片槽填上');
    check('从表情库选图填进模板', true);
    await cdp.eval("document.querySelector('.meme-generate').click()");
    const petResult = await cdp.waitFor("document.querySelector('.meme-result img') ? 1 : (document.querySelector('.meme-editor .error-text')?.textContent || 0)", 60000, '摸头生成结果').catch((e) => e.message);
    check('图片模板生成成功', petResult === 1, String(petResult));
    await cdp.eval("window.__uiStore.getState().toasts.length = 0; window.__uiStore.setState({ toasts: [] })");
    await cdp.eval("document.querySelector('.meme-copy')?.click()");
    const copyPet = await cdp.waitFor("window.__uiStore.getState().toasts.map((t) => t.kind + ':' + t.message).find((m) => /已复制|复制失败/.test(m)) || ''", 15000, '复制提示').catch(() => '');
    check('GIF 结果按文件复制（粘贴后仍是动图）', /^success:已复制（作为文件）/.test(copyPet), copyPet);
    await cdp.eval("document.querySelector('.meme-save')?.click()");
    const madePet = await cdp.waitFor("(() => { const x = window.__emojiStore.getState().stickers.find((t) => t.name.startsWith('摸 ')); return x ? x.file : ''; })()", 10000, '摸头存为表情').catch(() => '');
    check('图片模板生成 GIF 并保存', /\.gif$/.test(madePet), madePet);
    const petFrames = await cdp.eval(`(async () => { if (!${JSON.stringify(madePet)}) return 0; const r = await fetch('sticker://library/${madePet}'); const d = new ImageDecoder({ data: await r.arrayBuffer(), type: 'image/gif' }); await d.tracks.ready; await d.completed; const n = d.tracks.selectedTrack.frameCount; d.close(); return n; })()`);
    assertEq('摸头 GIF 有 5 帧', petFrames, 5);
    const memeShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(path.join(ROOT, '.e2e-tmp', 'screenshot-memes.png'), Buffer.from(memeShot.data, 'base64'));
    // 右键菜单入口：预填这张图
    await cdp.eval('window.__uiStore.getState().closeDialog()');
    const firstLocal = await cdp.eval("window.__emojiStore.getState().stickers.find((t) => t.source.type === 'local').id");
    await cdp.eval(`window.__emojiActions.openMemeTemplates('${firstLocal}')`);
    await cdp.waitFor("document.querySelectorAll('.meme-card').length >= 250 ? 1 : 0", 15000, '再次打开模板对话框');
    await cdp.eval("document.querySelector('.meme-card[data-key=petpet]').click()");
    const prefilled = await cdp.waitFor("document.querySelector('.meme-editor[data-key=petpet] .meme-slot img') ? 1 : 0", 5000, '预填图片').catch(() => 0);
    check('右键“用这张图套模板”预填第一张图', prefilled === 1);
    await cdp.eval('window.__uiStore.getState().closeDialog()');

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
    proc = launch(dataDir, memeEnv);
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
    // 最新的表情排在最前面（可能是刚用模板生成的 112px 摸头图），只要真的渲染出来了就行
    check('重启后图片正常显示', natural2 > 0, String(natural2));
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

    // ---- 局域网同步：再起一个实例（另一个数据目录）当作“另一台设备”，两边通过 UDP 发现、配对、双向同步
    console.log('\n局域网同步');
    const dataDir2 = path.join(ROOT, '.e2e-tmp', `${Date.now()}-b`);
    mkdirSync(dataDir2, { recursive: true });
    const proc2 = launch(dataDir2, memeEnv, PORT2);
    let cdp2;
    try {
      const page2 = await findPage('main', PORT2);
      cdp2 = await Cdp.connect(page2.webSocketDebuggerUrl);
      await cdp2.waitFor('window.__emojiStore && window.__emojiStore.getState().loaded', 20000, '第二个实例加载完成');
      // B 先有一张自己的表情（现画一张，保证 A 那边没有内容相同的图）
      const impB = await cdp2.eval(`(async () => { const c = document.createElement('canvas'); c.width = 40; c.height = 40; const x = c.getContext('2d'); x.fillStyle = '#3366cc'; x.fillRect(0, 0, 40, 40); x.fillStyle = '#fff'; x.fillRect(8, 8, 24, 24);
        const blob = await new Promise((r) => c.toBlob(r, 'image/png')); const b = new Uint8Array(await blob.arrayBuffer());
        return window.__emojiStore.getState().importFiles([{ name: 'B 自己的.png', bytes: b }], null); })()`);
      assertEq('B 导入自己的表情', impB.added, 1);
      const countA0 = await cdp.eval('window.__emojiStore.getState().stickers.length');
      const catsA0 = await cdp.eval('window.__emojiStore.getState().categories.length');

      // 两边都打开局域网同步
      await cdp.eval("window.__emojiStore.getState().updateSettings({ lanSync: true })");
      await cdp2.eval("window.__emojiStore.getState().updateSettings({ lanSync: true })");
      await cdp.waitFor('window.__lanStore.getState().running ? 1 : 0', 10000, 'A 的同步服务启动');
      await cdp2.waitFor('window.__lanStore.getState().running ? 1 : 0', 10000, 'B 的同步服务启动');
      check('两边的同步服务都启动了', true);
      const idA = await cdp.eval('window.__lanStore.getState().identity.id');
      const idB = await cdp2.eval('window.__lanStore.getState().identity.id');
      check('本机身份已生成', typeof idA === 'string' && idA.length === 32 && idA !== idB, `${idA} / ${idB}`);
      await cdp.waitFor(`window.__lanStore.getState().devices.some(d => d.id === '${idB}') ? 1 : 0`, 15000, 'A 发现 B');
      await cdp2.waitFor(`window.__lanStore.getState().devices.some(d => d.id === '${idA}') ? 1 : 0`, 15000, 'B 发现 A');
      check('两边通过 UDP 广播互相发现', true);
      const seenB = await cdp.eval(`window.__lanStore.getState().devices.find(d => d.id === '${idB}')`);
      check('发现的设备带有地址和端口', seenB.os === 'windows' && seenB.port > 0 && /^\d+\.\d+\.\d+\.\d+$/.test(seenB.host), JSON.stringify(seenB));
      // 改名会随下一条广播传过去
      await cdp.eval("window.__lanActions.renameSelf('测试电脑 A')");
      await cdp.waitFor(`window.__lanStore.getState().devices.find(d => d.id === '${idB}') ? 1 : 0`, 5000, 'B 仍在线');
      const renamed = await cdp2.waitFor(`window.__lanStore.getState().devices.find(d => d.id === '${idA}')?.name === '测试电脑 A' ? 1 : 0`, 10000, 'B 看到 A 的新名字').catch(() => 0);
      check('改名后对方看到新名字', renamed === 1);

      // 设备对话框列出未配对的设备
      await cdp.eval("window.__uiStore.getState().openDialog({ kind: 'lanDevices' })");
      await cdp.waitFor("document.querySelectorAll('.lan-item').length >= 1 ? 1 : 0", 5000, '设备列表');
      const rowText = await cdp.eval(`document.querySelector('.lan-item[data-device="${idB}"]')?.textContent ?? ''`);
      check('设备列表显示未配对的 B', rowText.includes('未配对') && rowText.includes('配对'), rowText.slice(0, 60));

      // 配对：A 发起 → B 弹出确认（配对码一致）→ 允许 → A 自动做第一次同步
      await cdp.eval(`document.querySelector('.lan-item[data-device="${idB}"] .btn.primary').click()`);
      const dialogB = await cdp2.waitFor("document.querySelector('.dialog h3')?.textContent === '允许配对？' ? document.querySelector('.dialog p')?.textContent : ''", 15000, 'B 弹出配对确认');
      const codeA = await cdp.eval("(window.__uiStore.getState().toasts.map(t => t.message).join(' ').match(/配对码 ([0-9A-F]{4})/) || [])[1] || ''");
      check('B 的确认框显示 A 的名字和同一个配对码', dialogB.includes('测试电脑 A') && !!codeA && dialogB.includes(`配对码：${codeA}`), `${codeA} / ${dialogB.slice(0, 80)}`);
      await cdp2.eval("Array.from(document.querySelectorAll('.dialog footer button')).find(b => b.textContent.includes('允许')).click()");
      await cdp.waitFor(`window.__lanStore.getState().identity.pairs.some(p => p.id === '${idB}') ? 1 : 0`, 15000, 'A 记下配对');
      await cdp2.waitFor(`window.__lanStore.getState().identity.pairs.some(p => p.id === '${idA}') ? 1 : 0`, 15000, 'B 记下配对');
      check('两边都记下了配对', true);
      const storedB = await cdp2.eval("JSON.parse(localStorage.getItem('emoji-manager.lan')).pairs.length");
      assertEq('配对信息存在 localStorage（不进资料文件）', storedB, 1);

      // 第一次同步：A 的全部表情到 B，B 的那张到 A
      await cdp.waitFor(`window.__emojiStore.getState().stickers.length === ${countA0 + 1} ? 1 : 0`, 30000, 'A 收到 B 的表情');
      await cdp2.waitFor(`window.__emojiStore.getState().stickers.length === ${countA0 + 1} ? 1 : 0`, 30000, 'B 收到 A 的表情');
      await cdp.waitFor('Object.keys(window.__lanStore.getState().syncing).length === 0 ? 1 : 0', 30000, 'A 同步结束');
      check('首次同步后两边表情数一致', true);
      assertEq('B 收到 A 的全部分类', await cdp2.eval('window.__emojiStore.getState().categories.length'), catsA0);
      // 拿 A 的一张有分类、有标签的表情，看 B 那边是否原样（文件名相同、名字 / 分类 / 标签相同、来源变为本地）
      const sampleA = await cdp.eval("(() => { const x = window.__emojiStore.getState().stickers.find(t => t.categoryId && t.tags.length); return { id: x.id, name: x.name, file: x.file, cat: x.categoryId, tags: x.tags }; })()");
      const sampleB = await cdp2.eval(`(() => { const x = window.__emojiStore.getState().stickers.find(t => t.id === '${sampleA.id}'); return x ? { id: x.id, name: x.name, file: x.file, cat: x.categoryId, tags: x.tags, src: x.source.type } : null; })()`);
      check('同步过来的表情保留名字、分类、标签，来源为本地', !!sampleB && sampleB.name === sampleA.name && sampleB.file === sampleA.file && sampleB.cat === sampleA.cat && JSON.stringify(sampleB.tags) === JSON.stringify(sampleA.tags) && sampleB.src === 'local', JSON.stringify({ sampleA, sampleB }));
      check('图片文件真的传到了 B 的数据目录', existsSync(path.join(dataDir2, 'library', sampleA.file)));
      const pairStatus = await cdp.eval(`window.__lanStore.getState().identity.pairs.find(p => p.id === '${idB}')`);
      check('A 记录了同步时间和结果', pairStatus.lastSyncAt > 0 && !pairStatus.lastError && /本机新增 1/.test(pairStatus.lastResult ?? '') && new RegExp(`对方新增 ${countA0}，分类改动 ${catsA0}`).test(pairStatus.lastResult ?? ''), JSON.stringify(pairStatus));
      await cdp.eval('window.__uiStore.getState().closeDialog()');

      // 增量：A 改名 + 删除 + 新建分类并移动，B 收藏；自动同步后两边一致
      const [renameTarget, delTarget] = await cdp.eval("window.__emojiStore.getState().stickers.filter(s => s.source.type === 'local' && s.categoryId).slice(0, 2).map(s => s.id)");
      const favTarget = await cdp2.eval("window.__emojiStore.getState().stickers.find(s => s.name === 'B 自己的').id");
      const newCatId = await cdp.eval("window.__emojiStore.getState().addCategory('局域网新分类').id");
      await cdp.eval(`window.__emojiStore.getState().setCategoryFor(['${renameTarget}'], '${newCatId}')`);
      await cdp.eval(`window.__emojiStore.getState().updateSticker('${renameTarget}', { name: '局域网改的名' })`);
      await cdp.eval(`window.__emojiStore.getState().deleteStickers(['${delTarget}'])`);
      await cdp2.eval(`window.__emojiStore.getState().toggleFavorite('${favTarget}')`);
      const tomb = await cdp.eval("window.__emojiStore.getState().deleted.filter(t => t.kind === 'sticker').length");
      check('删除后留下删除记录', tomb >= 1, String(tomb));
      await cdp2.waitFor(`(() => { const s = window.__emojiStore.getState(); return s.stickers.some(x => x.id === '${renameTarget}' && x.name === '局域网改的名' && x.categoryId === '${newCatId}') && s.categories.some(c => c.id === '${newCatId}' && c.name === '局域网新分类') && !s.stickers.some(x => x.id === '${delTarget}') ? 1 : 0; })()`, 40000, 'B 收到改名、新分类和删除');
      await cdp.waitFor(`window.__emojiStore.getState().stickers.find(x => x.id === '${favTarget}')?.favorite ? 1 : 0`, 40000, 'A 收到收藏');
      check('改名、新建分类并移动、删除、收藏自动双向同步', true);
      // B 删掉这个分类：A 那边分类消失，里面的表情回到未分类
      await cdp2.eval(`window.__emojiStore.getState().deleteCategory('${newCatId}', false)`);
      await cdp.waitFor(`(() => { const s = window.__emojiStore.getState(); return !s.categories.some(c => c.id === '${newCatId}') && s.stickers.find(x => x.id === '${renameTarget}')?.categoryId === null ? 1 : 0; })()`, 40000, 'A 收到分类删除');
      check('删除分类同步过去，里面的表情回到未分类', true);
      check('被删表情的图片在 B 也删掉了', !readdirSync(path.join(dataDir2, 'library', 'stickers')).some((f) => f.startsWith(delTarget)));

      // 内容相同的图片两边各自导入：合并成一条，B 的文件改名复用，不重复
      const pngHash = createHash('sha256').update(Buffer.from(png, 'base64')).digest('hex');
      const localA = await cdp.eval(`window.__emojiStore.getState().stickers.find(s => s.hash === '${pngHash}')`);
      check('A 里有这张图（去重用的 sha256）', !!localA, pngHash.slice(0, 8));
      const countBeforeDup = await cdp2.eval('window.__emojiStore.getState().stickers.length');
      const impDup = await cdp2.eval(`(() => { const b = Uint8Array.from(atob('${png}'), c => c.charCodeAt(0));
        return window.__emojiStore.getState().importFiles([{ name: 'B 也导入了同一张.png', bytes: b }], null); })()`);
      // B 已经从 A 同步到了这张图，所以按内容去重直接跳过；换个方式制造“各自导入”：先删掉 B 的那张（留墓碑），再导入 → 新 id
      check('B 导入时按内容去重（已经同步过来了）', impDup.skipped === 1 && impDup.added === 0, JSON.stringify(impDup));
      await cdp2.eval(`window.__emojiStore.getState().deleteStickers(['${localA.id}'])`);
      const impDup2 = await cdp2.eval(`(() => { const b = Uint8Array.from(atob('${png}'), c => c.charCodeAt(0));
        return window.__emojiStore.getState().importFiles([{ name: 'B 重新导入同一张.png', bytes: b }], null); })()`);
      check('B 删除后重新导入得到新 id', impDup2.added === 1, JSON.stringify(impDup2));
      const dupIdB = await cdp2.eval(`window.__emojiStore.getState().stickers.find(s => s.hash === '${pngHash}').id`);
      check('新 id 和 A 的不同', dupIdB !== localA.id);
      // 同步后：A 的那条被 B 的墓碑删掉（B 删得比 A 改得晚），B 新导入的那条传给 A → 两边各一条，id 是 B 的新 id
      await cdp.waitFor(`(() => { const s = window.__emojiStore.getState(); const same = s.stickers.filter(x => x.hash === '${pngHash}'); return same.length === 1 && same[0].id === '${dupIdB}' ? 1 : 0; })()`, 40000, 'A 收到删除和新导入');
      await cdp2.waitFor('Object.keys(window.__lanStore.getState().syncing).length === 0 ? 1 : 0', 30000, 'B 空闲');
      assertEq('B 里这张图仍只有一条', await cdp2.eval(`window.__emojiStore.getState().stickers.filter(x => x.hash === '${pngHash}').length`), 1);
      assertEq('B 的表情数不变（删一张、导一张）', await cdp2.eval('window.__emojiStore.getState().stickers.length'), countBeforeDup);
      await cdp.waitFor('Object.keys(window.__lanStore.getState().syncing).length === 0 ? 1 : 0', 30000, 'A 空闲');
      await cdp2.waitFor('Object.keys(window.__lanStore.getState().syncing).length === 0 ? 1 : 0', 30000, 'B 空闲');
      await sleep(4000);
      const finalA = await cdp.eval("(() => { const s = window.__emojiStore.getState(); return { n: s.stickers.length, ids: s.stickers.map(x => x.id).sort().join(','), cats: s.categories.length }; })()");
      const finalB = await cdp2.eval("(() => { const s = window.__emojiStore.getState(); return { n: s.stickers.length, ids: s.stickers.map(x => x.id).sort().join(','), cats: s.categories.length }; })()");
      check('稳定后两边的表情集合完全一致', finalA.ids === finalB.ids && finalA.cats === finalB.cats, `${finalA.n} / ${finalB.n}`);
      // 两边一致时不应再有文件传输：再手动同步一次
      const again = await cdp.eval(`window.__lanActions.syncWith('${idB}', { manual: true })`);
      check('再次同步没有变化、不传文件', again && again.sent === 0 && again.received === 0 && again.local.added === 0 && again.remote.added === 0, JSON.stringify(again));

      // 解除配对：B 解除并通知 A
      await cdp2.eval(`window.__lanActions.removePair('${idA}', true)`);
      await cdp.waitFor(`window.__lanStore.getState().identity.pairs.length === 0 ? 1 : 0`, 10000, 'A 收到解除配对');
      check('一边解除配对后另一边也解除', true);
      // 关掉 B：A 的列表里 B 下线
      await Promise.race([cdp2.eval('window.emojiBridge.quit()').catch(() => undefined), sleep(3000)]);
      cdp2.close();
      cdp2 = null;
      const code3 = await Promise.race([proc2.exited, sleep(10000).then(() => 'timeout')]);
      check('第二个实例正常退出', code3 === 0, `退出码 ${code3}`);
      const offline = await cdp.waitFor(`window.__lanStore.getState().devices.some(d => d.id === '${idB}') ? 0 : 1`, 20000, 'B 下线').catch(() => 0);
      check('对方退出后十几秒内从在线列表消失', offline === 1);
      await cdp.eval("window.__emojiStore.getState().updateSettings({ lanSync: false })");
      await cdp.waitFor('window.__lanStore.getState().running ? 0 : 1', 5000, '关闭开关后服务停止');
      check('关闭开关后服务停止', true);
      const logs2 = proc2.logs.join('');
      const errs2 = logs2.split('\n').filter((l) => /\b(Error|Uncaught|TypeError)\b/.test(l) && !/DevTools/.test(l));
      check('第二个实例的主进程没有报错', errs2.length === 0, errs2.slice(0, 2).join(' | '));
    } finally {
      if (cdp2) cdp2.close();
      if (proc2.child.exitCode === null) proc2.child.kill();
    }

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
