/**
 * 内置更新（Windows 安装版）：用 electron-updater 下载新版本的安装包，校验后静默安装、自动重启。
 *
 * - 版本检查仍由页面做（src/core/update.ts：GitHub → 加速站 → jsDelivr 三级回退），这里只管下载和安装。
 *   页面把安装包所在目录的地址（可以带加速站前缀）交过来，electron-updater 读该目录下的 latest.yml
 *   （CI 随 Release 一起发布，里面有安装包的 sha512），下载后校验；本机缓存着上一版安装包时只下载有差异的块。
 * - 安装：先让应用正常退出（页面把资料写完），在 quit 事件里启动安装程序（/S 静默、--updated 升级模式，
 *   装到原来的目录），用户点过“立即安装”时装完由安装程序重新拉起应用（--force-run）。
 * - 便携版没有安装目录、开发模式没有 app-update.yml，都不支持；测试可用 EMOJI_UPDATE_CONFIG 指定一份配置文件。
 */
import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CancellationToken, NsisUpdater, type ProgressInfo } from 'electron-updater';
import { describeUpdateError } from '../src/core/update';
import type { UpdateDownloadRequest, UpdateState } from '../src/platform/types';

export interface UpdaterHost {
  broadcast(channel: string, payload?: unknown): void;
}

/** 这种运行方式能不能内置更新：Windows 安装版才行（便携版从临时目录运行、没有安装目录） */
export function builtinUpdatesAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  if (process.env.EMOJI_UPDATE_CONFIG) return true;
  return app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
}

function idle(): UpdateState {
  return { phase: 'idle', version: '', percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export class BuiltinUpdater {
  private updater: NsisUpdater | null = null;
  private state: UpdateState = idle();
  private token: CancellationToken | null = null;
  /** 下载好的安装包（在 electron-updater 的缓存目录 pending/ 下） */
  private downloadedFile: string | null = null;
  /** 用户点了“立即安装”（装完要重新启动应用）；只是退出时顺便装的就不再拉起 */
  private installRequested = false;
  /** 正常退出时顺便把下载好的更新装上；改数据目录后的“重启”这种退出不算 */
  private installOnQuit = true;
  /** “不装了”时删缓存目录是异步的，下一次下载要等它删完（两者用的是同一个目录） */
  private cleanup: Promise<void> = Promise.resolve();

  constructor(private readonly host: UpdaterHost) {}

  current(): UpdateState {
    return { ...this.state };
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.host.broadcast('update:state', this.current());
  }

  /**
   * 每次下载新建一个 updater：electron-updater 会把进行中的 checkForUpdates 复用给后来的调用，
   * 用户取消一条线路再换一条时，新的一次不能被旧的（可能要等 60 秒才超时）拖住
   */
  private createUpdater(): NsisUpdater {
    const u = new NsisUpdater();
    u.autoDownload = false;
    // 退出时装不装由这里的 onQuit 决定（electron-updater 自带的那个装完不会重新启动应用）
    u.autoInstallOnAppQuit = false;
    u.disableWebInstaller = true;
    if (process.env.EMOJI_UPDATE_CONFIG) {
      u.forceDevUpdateConfig = true;
      u.updateConfigPath = process.env.EMOJI_UPDATE_CONFIG;
    }
    u.logger = {
      info: (m) => console.log('[更新]', String(m).split('\n')[0]),
      warn: (m) => console.warn('[更新]', String(m).split('\n')[0]),
      // 原始报错是一大段英文（还带堆栈和响应头），只记翻译后的一句；增量下载失败会自动改为完整下载，不算错误
      error: (m) => {
        const text = String(m);
        if (/fallback to full download/.test(text)) console.log('[更新] 无法增量下载（', describeUpdateError(text.replace(/^[^]*?fallback to full download:\s*/, '')), '），改为完整下载');
        else console.warn('[更新] 失败：', describeUpdateError(text));
      },
    };
    u.on('download-progress', (p: ProgressInfo) => {
      if (this.updater !== u || this.state.phase !== 'downloading') return;
      this.set({ percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond });
    });
    return u;
  }

  /**
   * 下载某个版本的安装包；同一版本已经下载好的直接返回。
   * 返回最终状态：成功是 downloaded；失败是 error（error 字段是原因）；取消是 idle 但返回值里带 error: '已取消'。
   * 只有请求本身不合法才抛错
   */
  async download(req: UpdateDownloadRequest): Promise<UpdateState> {
    if (!builtinUpdatesAvailable()) throw new Error('这种运行方式不支持内置更新');
    if (!isRecord(req) || typeof req.baseUrl !== 'string' || typeof req.version !== 'string') throw new Error('无效的下载请求');
    let base: URL;
    try {
      base = new URL(req.baseUrl);
    } catch {
      throw new Error('无效的下载地址');
    }
    if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('只支持 http/https 地址');
    if (!base.pathname.endsWith('/')) base.pathname += '/';
    const version = req.version.trim();
    const via = typeof req.via === 'string' ? req.via : undefined;
    const sha256 = typeof req.sha256 === 'string' ? req.sha256.trim().toLowerCase() : '';
    await this.cleanup;
    if (this.state.phase === 'checking' || this.state.phase === 'downloading') {
      return { ...this.current(), error: this.state.version === version ? '正在下载这个版本' : '正在下载另一个版本，请先取消' };
    }
    if (this.state.phase === 'downloaded' && this.state.version === version) return this.current();

    const u = this.createUpdater();
    this.updater = u;
    const token = new CancellationToken();
    this.token = token;
    this.downloadedFile = null;
    this.set({ phase: 'checking', version, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0, error: undefined, via });
    try {
      // 增量下载走单个 Range 请求：加速站未必支持一次要多段的 multipart 响应
      u.setFeedURL({ provider: 'generic', url: base.href, useMultipleRangeRequest: false });
      // 读 latest.yml 这一步 electron-updater 不支持取消，用户点了取消就不再等它
      const cancelled = new Promise<never>((_resolve, reject) => token.once('cancel', () => reject(new Error('cancelled'))));
      const r = await Promise.race([u.checkForUpdates(), cancelled]);
      if (!r) throw new Error('这种运行方式不支持内置更新');
      if (r.updateInfo.version !== version) throw new Error(`更新文件里的版本（${r.updateInfo.version}）和要安装的版本（${version}）不一致`);
      if (!r.isUpdateAvailable) throw new Error(`${version} 不比当前版本新`);
      if (token.cancelled) throw new Error('cancelled');
      this.set({ phase: 'downloading' });
      const files = await u.downloadUpdate(token);
      const file = files[0];
      if (!file) throw new Error('下载完成但没有得到文件');
      if (sha256) {
        const actual = await sha256File(file);
        if (actual !== sha256) {
          // 和 GitHub 直接给出的校验值对不上：下载途经的站点给了别的内容。删掉，下次重新下载
          await fsp.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined);
          throw new Error('checksum mismatch: sha256');
        }
      }
      this.downloadedFile = file;
      this.set({ phase: 'downloaded', percent: 100, transferred: this.state.total || this.state.transferred, bytesPerSecond: 0 });
      return this.current();
    } catch (e) {
      const cancelled = token.cancelled || (e instanceof Error && e.message === 'cancelled');
      const error = cancelled ? '已取消' : describeUpdateError(e);
      this.set(cancelled ? { ...idle() } : { phase: 'error', error, bytesPerSecond: 0 });
      return { ...this.current(), error };
    } finally {
      if (this.token === token) this.token = null;
    }
  }

  /** 正在下载：取消；已下载好：删掉安装包、退出时不再安装（用户“跳过这个版本”或“不装了”） */
  async cancel(): Promise<void> {
    if (this.token) {
      this.token.cancel();
      return;
    }
    const file = this.downloadedFile;
    this.downloadedFile = null;
    if (file) {
      // 先删干净再报“空闲”：下一次下载会在同一个目录里建临时文件
      this.cleanup = fsp.rm(path.dirname(file), { recursive: true, force: true }).catch(() => undefined);
      await this.cleanup;
    }
    if (this.state.phase !== 'idle') this.set({ ...idle() });
  }

  /** 退出应用并安装（真正的安装在 onQuit 里启动） */
  installNow(): void {
    if (this.state.phase !== 'downloaded' || !this.updater) throw new Error('还没有下载好新版本');
    this.installRequested = true;
    app.quit();
  }

  /** 这次退出不要装（应用马上会自己重新启动，装到一半会被安装程序杀掉） */
  suppressInstallOnQuit(): void {
    this.installOnQuit = false;
  }

  /** app 的 quit 事件：进程退出前启动安装程序。用户点过“立即安装”时装完重新启动应用，退出时顺便装的不再拉起 */
  onQuit(exitCode: number): void {
    if (this.state.phase !== 'downloaded' || !this.updater || !this.downloadedFile) return;
    if (!this.installRequested && (exitCode !== 0 || !this.installOnQuit)) return;
    try {
      // /S 静默 + --updated 升级模式；用户点过“立即安装”再加 --force-run，装完由安装程序（经资源管理器）启动新版
      this.updater.install(true, this.installRequested);
    } catch (e) {
      console.warn('[更新] 启动安装程序失败：', describeUpdateError(e));
    }
  }
}
