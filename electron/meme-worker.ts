/**
 * 模板表情的工具进程：在这里加载 @memecrafters/meme-generator（原生模块，Skia 渲染，内置 299 个沙雕表情模板）。
 * 生成是同步的、吃 CPU（GIF 编码可能要几秒），放主进程会把所有 IPC 卡住；单独一个进程也能隔离原生崩溃。
 * 主进程通过 process.parentPort 发请求，这里按 id 回复。
 */
import { createRequire } from 'node:module';
import type { Error as MemeError, Meme, MemeInfo, MemeOption, OptionValue } from '@memecrafters/meme-generator';
import type { MemeImageInput, MemeOptionSchema, MemeOptionValues, MemeTemplate } from '../src/platform/types';

type Native = typeof import('@memecrafters/meme-generator');

export interface WorkerRequest {
  id: number;
  type: 'init' | 'list' | 'preview' | 'generate';
  /** init：原生库（.node）的路径 */
  nativePath?: string;
  key?: string;
  options?: MemeOptionValues;
  images?: MemeImageInput[];
  texts?: string[];
}

export interface WorkerError {
  /** 原生模块的错误类型名，如 ImageAssetMissing */
  code: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface WorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: WorkerError;
}

let native: Native | null = null;

/**
 * 直接 require 原生库。npm 包自带的加载器（js-binding.js）在这个版本里有两个坑：
 * NAPI_RS_NATIVE_LIBRARY_PATH 分支赋了值却没 return，结果被覆盖成 undefined；本地文件分支用 URL.pathname 拼路径，Windows 上会多出一个斜杠。
 * 原生库导出的就是 index.js 再导出的那些函数，绕过去最省事。
 */
function load(nativePath: string): Native {
  if (!native) native = createRequire(import.meta.url)(nativePath) as Native;
  return native;
}

function optionSchema(o: MemeOption): MemeOptionSchema {
  const f = o.field0 as {
    name: string;
    default?: boolean | string | number | null;
    description?: string | null;
    choices?: string[] | null;
    minimum?: number | null;
    maximum?: number | null;
  };
  return {
    name: f.name,
    type: o.type.toLowerCase() as MemeOptionSchema['type'],
    default: f.default ?? null,
    description: f.description ?? null,
    choices: f.choices ?? undefined,
    minimum: f.minimum ?? null,
    maximum: f.maximum ?? null,
  };
}

function isoDate(d: unknown): string {
  if (d instanceof Date) return d.toISOString();
  return typeof d === 'string' ? d : '';
}

function toTemplate(info: MemeInfo): MemeTemplate {
  return {
    key: info.key,
    keywords: [...info.keywords],
    tags: Array.from(info.tags).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
    minImages: info.params.minImages,
    maxImages: info.params.maxImages,
    minTexts: info.params.minTexts,
    maxTexts: info.params.maxTexts,
    defaultTexts: [...info.params.defaultTexts],
    options: info.params.options.map(optionSchema),
    shortcuts: info.shortcuts.map((s) => ({ pattern: s.pattern, humanized: s.humanized ?? null })),
    dateCreated: isoDate(info.dateCreated),
    dateModified: isoDate(info.dateModified),
  };
}

/** 把普通的 { 名字: 值 } 按模板的选项类型包成原生模块要的 { type, field0 } */
function wrapOptions(meme: Meme, values: MemeOptionValues | undefined): Record<string, OptionValue> {
  const out: Record<string, OptionValue> = {};
  if (!values) return out;
  const types = new Map(meme.info.params.options.map((o) => [o.field0.name, o.type]));
  for (const [name, value] of Object.entries(values)) {
    const type = types.get(name);
    if (!type || value === null || value === undefined) continue;
    if (type === 'Boolean') out[name] = { type: 'Boolean', field0: Boolean(value) };
    else if (type === 'String') out[name] = { type: 'String', field0: String(value) };
    else if (type === 'Integer') out[name] = { type: 'Integer', field0: Math.round(Number(value)) };
    else out[name] = { type: 'Float', field0: Number(value) };
  }
  return out;
}

function describeError(err: MemeError): WorkerError {
  switch (err.type) {
    case 'ImageDecodeError':
      return { code: err.type, message: `图片无法解码：${err.field0.error}` };
    case 'ImageEncodeError':
      return { code: err.type, message: `图片编码失败：${err.field0.error}` };
    case 'ImageAssetMissing':
      return { code: err.type, message: `缺少模板素材：${err.field0.path}`, data: { path: err.field0.path } };
    case 'DeserializeError':
      return { code: err.type, message: `选项无效：${err.field0.error}` };
    case 'ImageNumberMismatch':
      return { code: err.type, message: `这个模板需要 ${err.field0.min}~${err.field0.max} 张图片，现在给了 ${err.field0.actual} 张` };
    case 'TextNumberMismatch':
      return { code: err.type, message: `这个模板需要 ${err.field0.min}~${err.field0.max} 段文字，现在给了 ${err.field0.actual} 段` };
    case 'TextOverLength':
      return { code: err.type, message: `文字太长，放不下：${err.field0.text}` };
    case 'MemeFeedback':
      return { code: err.type, message: err.field0.feedback };
    default:
      return { code: 'Unknown', message: JSON.stringify(err) };
  }
}

class MemeFailure extends Error {
  constructor(readonly detail: WorkerError) {
    super(detail.message);
  }
}

function unwrap(result: { type: 'Ok'; field0: Buffer } | { type: 'Err'; field0: MemeError }): Uint8Array {
  if (result.type === 'Ok') return new Uint8Array(result.field0);
  throw new MemeFailure(describeError(result.field0));
}

function getMeme(key: string): Meme {
  if (!native) throw new Error('模板引擎还没有初始化');
  const meme = native.getMeme(key);
  if (!meme) throw new MemeFailure({ code: 'NotFound', message: `没有这个模板：${key}` });
  return meme;
}

async function handle(req: WorkerRequest): Promise<unknown> {
  switch (req.type) {
    case 'init': {
      if (!req.nativePath) throw new Error('没有指定原生库路径');
      const mod = load(req.nativePath);
      return { version: mod.getVersion(), count: mod.getMemeKeys().length };
    }
    case 'list': {
      if (!native) throw new Error('模板引擎还没有初始化');
      return native.getMemes(native.MemeSortBy.KeywordsPinyin, false).map((m) => toTemplate(m.info));
    }
    case 'preview': {
      const meme = getMeme(req.key ?? '');
      return { bytes: unwrap(meme.generatePreview(wrapOptions(meme, req.options))) };
    }
    case 'generate': {
      const meme = getMeme(req.key ?? '');
      const images = (req.images ?? []).map((img) => ({
        name: img.name,
        data: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength),
      }));
      return { bytes: unwrap(meme.generate(images, req.texts ?? [], wrapOptions(meme, req.options))) };
    }
    default:
      throw new Error(`未知请求：${String((req as { type: unknown }).type)}`);
  }
}

function toWorkerError(e: unknown): WorkerError {
  if (e instanceof MemeFailure) return e.detail;
  return { code: 'Error', message: e instanceof Error ? e.message : String(e) };
}

process.parentPort.on('message', (e) => {
  const req = e.data as WorkerRequest;
  void handle(req).then(
    (result) => process.parentPort.postMessage({ id: req.id, ok: true, result } satisfies WorkerReply),
    (err) => process.parentPort.postMessage({ id: req.id, ok: false, error: toWorkerError(err) } satisfies WorkerReply),
  );
});
