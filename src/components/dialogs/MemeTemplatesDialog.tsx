import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { platform } from '../../platform';
import type { MemeOptionSchema, MemeOptionValues, MemeProgress, MemeStatus, MemeTemplate } from '../../platform/types';
import type { Sticker } from '../../core/types';
import { errorMessage } from '../../core/subscription/sync';
import { fileStem, mimeFromExt } from '../../core/images';
import { flattenTree } from '../../core/selectors';
import {
  checkImageCount,
  clampOptionValue,
  defaultOptionValues,
  describeRequirements,
  filterTemplates,
  resolveTexts,
  templateKind,
  templateTitle,
  topTags,
  type TemplateKind,
} from '../../core/memeTemplates';
import { currentCategoryId, pickFiles } from '../../ui/actions';
import { useFileUrl } from '../../ui/hooks';
import { Modal } from '../Dialog';
import { Icon, Spinner } from '../../ui/icons';

const FONTS_SIZE_HINT = '约 77 MB';

function bytesUrl(bytes: Uint8Array, ext: string): string {
  return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mimeFromExt(ext) }));
}

// ---------------------------------------------------------------- 预览图：按可见顺序逐个向主进程要，整个会话内缓存

const previewCache = new Map<string, string>();
const previewFailed = new Set<string>();
const previewWaiters = new Map<string, Set<(url: string | null) => void>>();
let previewQueue: string[] = [];
let previewActive = 0;
const PREVIEW_CONCURRENCY = 2;

function notifyPreview(key: string): void {
  const url = previewCache.get(key) ?? null;
  const waiters = previewWaiters.get(key);
  previewWaiters.delete(key);
  if (waiters) for (const cb of waiters) cb(url);
}

function pumpPreviews(): void {
  while (previewActive < PREVIEW_CONCURRENCY && previewQueue.length > 0) {
    // 后进先出：刚滚到的那些先生成
    const key = previewQueue.pop()!;
    if (previewCache.has(key) || previewFailed.has(key)) {
      notifyPreview(key);
      continue;
    }
    previewActive++;
    platform
      .memePreview(key)
      .then(
        (r) => previewCache.set(key, bytesUrl(r.bytes, r.ext)),
        () => previewFailed.add(key),
      )
      .finally(() => {
        previewActive--;
        notifyPreview(key);
        pumpPreviews();
      });
  }
}

function requestPreview(key: string, cb: (url: string | null) => void): void {
  const cached = previewCache.get(key);
  if (cached) {
    cb(cached);
    return;
  }
  if (previewFailed.has(key)) {
    cb(null);
    return;
  }
  let waiters = previewWaiters.get(key);
  if (!waiters) {
    waiters = new Set();
    previewWaiters.set(key, waiters);
  }
  waiters.add(cb);
  if (!previewQueue.includes(key)) previewQueue.push(key);
  pumpPreviews();
}

function cancelPreview(key: string, cb: (url: string | null) => void): void {
  const waiters = previewWaiters.get(key);
  if (!waiters) return;
  waiters.delete(cb);
  if (waiters.size === 0) {
    previewWaiters.delete(key);
    previewQueue = previewQueue.filter((k) => k !== key);
  }
}

// ---------------------------------------------------------------- 模板卡片

const TemplateCard = memo(function TemplateCard({
  template: t,
  selected,
  enabled,
  onSelect,
}: {
  template: MemeTemplate;
  selected: boolean;
  enabled: boolean;
  onSelect: (key: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>(() => previewCache.get(t.key) ?? null);
  const [failed, setFailed] = useState(() => previewFailed.has(t.key));

  // 滚进视野再生成预览；滚走了还没轮到的就不生成了
  useEffect(() => {
    const el = ref.current;
    if (!enabled || url || failed || !el) return;
    let requested = false;
    const cb = (u: string | null) => {
      requested = false;
      if (u) setUrl(u);
      else setFailed(true);
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !requested) {
          requested = true;
          requestPreview(t.key, cb);
        } else if (!entry.isIntersecting && requested) {
          requested = false;
          cancelPreview(t.key, cb);
        }
      },
      { rootMargin: '160px' },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      if (requested) cancelPreview(t.key, cb);
    };
  }, [t.key, enabled, url, failed]);

  return (
    <button
      ref={ref}
      type="button"
      className={`meme-card${selected ? ' selected' : ''}`}
      data-key={t.key}
      title={t.keywords.join(' / ')}
      onClick={() => {
        // 预览失败过的（比如素材下载断了）再点一下就重试
        if (failed) {
          previewFailed.delete(t.key);
          setFailed(false);
        }
        onSelect(t.key);
      }}
    >
      <span className="pic">{url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <span className="ph">{failed ? '预览失败' : enabled ? '…' : ''}</span>}</span>
      <span className="title">{templateTitle(t)}</span>
      <span className="need">{templateKind(t) === 'image' ? `${t.maxImages} 图` : templateKind(t) === 'text' ? `${t.maxTexts} 字` : '图 + 字'}</span>
    </button>
  );
});

// ---------------------------------------------------------------- 从表情库选图

function PickerThumb({ sticker }: { sticker: Sticker }) {
  const url = useFileUrl(sticker.thumb ?? sticker.file);
  return url ? <img src={url} alt={sticker.name} loading="lazy" draggable={false} /> : null;
}

function StickerPicker({ onPick, onFile, onCancel }: { onPick: (s: Sticker) => void; onFile: () => void; onCancel: () => void }) {
  const stickers = useLibraryStore((s) => s.stickers);
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const query = q.trim().toLowerCase();
    const all = query ? stickers.filter((s) => s.name.toLowerCase().includes(query) || s.tags.some((t) => t.toLowerCase().includes(query))) : stickers;
    return all.slice(0, 300);
  }, [stickers, q]);
  return (
    <div className="meme-picker">
      <div className="row">
        <input className="input" type="search" value={q} placeholder="搜索表情库…" autoFocus onChange={(e) => setQ(e.target.value)} aria-label="搜索表情库" />
        <button type="button" className="btn sm" onClick={onFile}>
          选择文件…
        </button>
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          取消
        </button>
      </div>
      {list.length === 0 ? (
        <div className="hint">{stickers.length === 0 ? '表情库还是空的，先导入几张图或者选择文件。' : '没有符合的表情'}</div>
      ) : (
        <div className="meme-picker-grid">
          {list.map((s) => (
            <button key={s.id} type="button" data-id={s.id} title={s.name} onClick={() => onPick(s)}>
              <PickerThumb sticker={s} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 选项表单

function OptionField({ schema, value, onChange }: { schema: MemeOptionSchema; value: boolean | string | number | undefined; onChange: (v: boolean | string | number) => void }) {
  const label = schema.description || schema.name;
  if (schema.type === 'boolean') {
    return (
      <label className="checkbox">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
        {label}
      </label>
    );
  }
  if (schema.type === 'string' && schema.choices && schema.choices.length > 0) {
    return (
      <label className="field">
        <span className="label">{label}</span>
        <select className="select" style={{ height: 30 }} value={String(value ?? schema.choices[0])} onChange={(e) => onChange(e.target.value)}>
          {schema.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (schema.type === 'string') {
    return (
      <label className="field">
        <span className="label">{label}</span>
        <input className="input" style={{ height: 30 }} value={String(value ?? '')} maxLength={200} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  const hasRange = schema.minimum !== null && schema.maximum !== null;
  const step = schema.type === 'integer' ? 1 : 0.1;
  return (
    <label className="field">
      <span className="label">
        {label}
        {hasRange ? <span className="hint">（{schema.minimum} ~ {schema.maximum}）</span> : null}
      </span>
      <div className="row">
        {hasRange && (
          <input
            type="range"
            min={schema.minimum ?? undefined}
            max={schema.maximum ?? undefined}
            step={step}
            value={Number(value ?? schema.default ?? schema.minimum ?? 0)}
            onChange={(e) => onChange(clampOptionValue(schema, e.target.value))}
            aria-label={label}
          />
        )}
        <input
          className="input num"
          style={{ height: 30, width: 72 }}
          type="number"
          min={schema.minimum ?? undefined}
          max={schema.maximum ?? undefined}
          step={step}
          value={value === undefined ? '' : Number(value)}
          onChange={(e) => onChange(clampOptionValue(schema, e.target.value))}
        />
      </div>
    </label>
  );
}

// ---------------------------------------------------------------- 右侧：填图、填字、生成、保存

interface SlotImage {
  /** 传给模板的名字（有的模板会把名字画出来） */
  name: string;
  bytes: Uint8Array;
  url: string;
}

interface Made {
  url: string;
  bytes: Uint8Array;
  ext: string;
}

function TemplateEditor({ template: t, enabled, initialStickerId, progress }: { template: MemeTemplate; enabled: boolean; initialStickerId?: string; progress: MemeProgress | null }) {
  const toast = useUiStore((s) => s.toast);
  const categories = useLibraryStore((s) => s.categories);
  const catOptions = useMemo(() => flattenTree(categories), [categories]);
  const [slots, setSlots] = useState<SlotImage[]>([]);
  const [texts, setTexts] = useState<string[]>(() => Array.from({ length: Math.max(t.minTexts, Math.min(t.maxTexts, 1)) }, () => ''));
  const [options, setOptions] = useState<MemeOptionValues>(() => defaultOptionValues(t));
  const [picking, setPicking] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [made, setMade] = useState<Made | null>(null);
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [categoryId, setCategoryId] = useState(() => currentCategoryId() ?? '');
  const prefilled = useRef(false);

  const setSlot = useCallback((index: number, img: SlotImage) => {
    setSlots((list) => {
      const next = [...list];
      if (index < next.length) {
        URL.revokeObjectURL(next[index].url);
        next[index] = img;
      } else next.push(img);
      return next;
    });
  }, []);

  const addSticker = useCallback(
    async (s: Sticker, index: number) => {
      const bytes = await platform.readBytes(s.file);
      if (!bytes) throw new Error('图片文件不存在');
      const url = await platform.fileUrl(s.file);
      setSlot(index, { name: s.name, bytes, url });
    },
    [setSlot],
  );

  // 从右键菜单带进来的表情填进第一个图片槽
  useEffect(() => {
    if (prefilled.current || !initialStickerId || t.maxImages === 0) return;
    prefilled.current = true;
    const s = useLibraryStore.getState().stickers.find((x) => x.id === initialStickerId);
    if (s) void addSticker(s, 0).catch((e) => toast(errorMessage(e), 'error'));
  }, [initialStickerId, t.maxImages, addSticker, toast]);

  useEffect(
    () => () => {
      if (made) URL.revokeObjectURL(made.url);
    },
    [made],
  );

  const addFile = async (index: number) => {
    const [f] = await pickFiles({ multiple: false });
    if (!f) return;
    setSlot(index, { name: fileStem(f.name), bytes: new Uint8Array(await f.arrayBuffer()), url: URL.createObjectURL(f) });
    setPicking(null);
  };
  const removeSlot = (index: number) =>
    setSlots((list) => {
      URL.revokeObjectURL(list[index].url);
      return list.filter((_, i) => i !== index);
    });

  const generate = async () => {
    setError('');
    const imgErr = checkImageCount(t, slots.length);
    if (imgErr) {
      setError(imgErr);
      return;
    }
    let finalTexts: string[];
    try {
      finalTexts = resolveTexts(t, texts);
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    setBusy(true);
    try {
      const r = await platform.memeGenerate(
        t.key,
        slots.map((s) => ({ name: s.name, data: s.bytes })),
        finalTexts,
        options,
      );
      setMade({ url: bytesUrl(r.bytes, r.ext), bytes: r.bytes, ext: r.ext });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const defaultName = useMemo(() => {
    const extra = texts[0]?.trim() ? texts[0].trim().slice(0, 20) : slots[0]?.name ? slots[0].name.slice(0, 20) : '';
    return extra ? `${templateTitle(t)} ${extra}` : templateTitle(t);
  }, [t, texts, slots]);
  const finalName = (nameEdited ? name : defaultName).trim() || templateTitle(t);

  const save = async () => {
    if (!made) return;
    const target = categoryId || null;
    try {
      const r = await useLibraryStore.getState().importFiles([{ name: `${finalName}.${made.ext}`, bytes: made.bytes, displayName: finalName, categoryId: target }], target);
      if (r.added) toast(`已保存为新表情“${finalName}”`, 'success');
      else if (r.moved || r.skipped) toast('已经有一张一模一样的表情了');
      else toast(r.errors[0] ?? '保存失败', 'error');
    } catch (e) {
      toast(`保存失败：${errorMessage(e)}`, 'error');
    }
  };
  const saveAs = async () => {
    if (!made) return;
    try {
      const r = await platform.saveFile(`${finalName}.${made.ext}`, made.bytes);
      if (r.saved) toast('已保存', 'success');
    } catch (e) {
      toast(`保存失败：${errorMessage(e)}`, 'error');
    }
  };

  const otherKeywords = t.keywords.slice(1);
  const imageProgress = progress && progress.kind === 'images' && (!progress.key || progress.key === t.key) && progress.done < progress.total ? progress : null;

  return (
    <div className="meme-editor" data-key={t.key}>
      <div>
        <h4>{templateTitle(t)}</h4>
        <div className="hint">
          {describeRequirements(t)}
          {otherKeywords.length > 0 && ` · 也叫 ${otherKeywords.join('、')}`}
        </div>
        {t.tags.length > 0 && (
          <div className="meme-tags">
            {t.tags.map((tag) => (
              <span key={tag} className="chip">
                <span className="label">{tag}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {t.maxImages > 0 && (
        <div className="field">
          <span className="label">图片</span>
          <div className="meme-slots">
            {slots.map((s, i) => (
              <div key={i} className="meme-slot">
                <span className="pic">
                  <img src={s.url} alt="" draggable={false} />
                </span>
                <input
                  className="input"
                  value={s.name}
                  maxLength={40}
                  title="名字：有的模板会把它画在图上"
                  aria-label={`第 ${i + 1} 张图的名字`}
                  onChange={(e) => setSlots((list) => list.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <span className="actions">
                  <button type="button" className="btn sm ghost icon-only" title="换一张" onClick={() => setPicking(i)}>
                    <Icon name="image" size={15} />
                  </button>
                  <button type="button" className="btn sm ghost icon-only" title="移除" onClick={() => removeSlot(i)}>
                    <Icon name="x" size={15} />
                  </button>
                </span>
              </div>
            ))}
            {slots.length < t.maxImages && picking === null && (
              <button type="button" className="btn sm meme-add-image" onClick={() => setPicking(slots.length)}>
                <Icon name="plus" size={14} /> {slots.length === 0 ? '选一张图片' : '再加一张'}
              </button>
            )}
            {picking !== null && (
              <StickerPicker
                onPick={(s) => {
                  const idx = picking;
                  setPicking(null);
                  void addSticker(s, idx).catch((e) => toast(errorMessage(e), 'error'));
                }}
                onFile={() => void addFile(picking)}
                onCancel={() => setPicking(null)}
              />
            )}
          </div>
        </div>
      )}

      {t.maxTexts > 0 && (
        <div className="field">
          <span className="label">文字</span>
          {texts.map((text, i) => (
            <div key={i} className="row">
              <input
                className="input meme-text"
                value={text}
                maxLength={500}
                placeholder={t.defaultTexts[i] ? `默认：${t.defaultTexts[i]}` : `第 ${i + 1} 段文字`}
                onChange={(e) => setTexts((list) => list.map((x, j) => (j === i ? e.target.value : x)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void generate();
                  }
                }}
              />
              {texts.length > t.minTexts && (
                <button type="button" className="btn sm ghost icon-only" title="去掉这段" onClick={() => setTexts((list) => list.filter((_, j) => j !== i))}>
                  <Icon name="x" size={15} />
                </button>
              )}
            </div>
          ))}
          {texts.length < t.maxTexts && (
            <button type="button" className="btn sm" onClick={() => setTexts((list) => [...list, ''])}>
              <Icon name="plus" size={14} /> 再加一段
            </button>
          )}
        </div>
      )}

      {t.options.length > 0 && (
        <div className="field">
          <span className="label">选项</span>
          <div className="meme-options">
            {t.options.map((o) => (
              <OptionField key={o.name} schema={o} value={options[o.name]} onChange={(v) => setOptions((cur) => ({ ...cur, [o.name]: v }))} />
            ))}
          </div>
        </div>
      )}

      {error && <div className="error-text">{error}</div>}
      <div className="row">
        <button type="button" className="btn primary meme-generate" disabled={!enabled || busy} onClick={() => void generate()}>
          {busy ? <Spinner /> : <Icon name="text" size={15} />} {busy ? (imageProgress ? `下载素材 ${imageProgress.done}/${imageProgress.total}…` : '生成中…') : made ? '重新生成' : '生成'}
        </button>
        {!enabled && <span className="hint">先下载字体</span>}
      </div>

      {made && (
        <div className="field meme-made">
          <div className="meme-result">
            <img src={made.url} alt="生成结果" />
          </div>
          <div className="maker-grid">
            <div className="field">
              <label htmlFor="meme-name">名称</label>
              <input id="meme-name" className="input" value={nameEdited ? name : defaultName} maxLength={80} onChange={(e) => { setName(e.target.value); setNameEdited(true); }} />
            </div>
            <div className="field">
              <label htmlFor="meme-category">分类</label>
              <select id="meme-category" className="select" style={{ height: 34 }} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">未分类</option>
                {catOptions.map(({ category: c, depth }) => (
                  <option key={c.id} value={c.id}>
                    {depth ? `${'　'.repeat(depth)}└ ${c.name}` : c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="row">
            <button type="button" className="btn primary meme-save" onClick={() => void save()}>
              保存为表情
            </button>
            <button type="button" className="btn" onClick={() => void saveAs()}>
              另存为文件…
            </button>
            <span className="hint">{made.ext.toUpperCase()}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 对话框

const KINDS: { key: 'all' | TemplateKind; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '要图片' },
  { key: 'text', label: '只要文字' },
  { key: 'mixed', label: '图加字' },
];

export function MemeTemplatesDialog({ stickerId }: { stickerId?: string }) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const [status, setStatus] = useState<MemeStatus | null>(null);
  const [templates, setTemplates] = useState<MemeTemplate[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | TemplateKind>('all');
  const [tag, setTag] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [progress, setProgress] = useState<MemeProgress | null>(null);
  const [fontBusy, setFontBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await platform.memeStatus());
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    previewFailed.clear();
    let alive = true;
    void refreshStatus();
    platform.memeList().then(
      (list) => {
        if (alive) setTemplates(list);
      },
      (e) => {
        if (alive) setLoadError(errorMessage(e));
      },
    );
    const off = platform.onMemeProgress((p) => {
      if (alive) setProgress(p);
    });
    return () => {
      alive = false;
      off();
    };
  }, [refreshStatus]);

  const fontsReady = !!status && status.available && status.fontsReady >= status.fontsTotal;
  const downloadFonts = async () => {
    setFontBusy(true);
    try {
      await platform.memeDownloadFonts();
      await refreshStatus();
      previewFailed.clear();
      toast('字体下载完成，可以开始做表情了', 'success');
    } catch (e) {
      toast(`下载失败：${errorMessage(e)}`, 'error');
      await refreshStatus();
    } finally {
      setFontBusy(false);
      setProgress(null);
    }
  };

  const visible = useMemo(() => (templates ? filterTemplates(templates, { query, kind, tag }) : []), [templates, query, kind, tag]);
  const tags = useMemo(() => (templates ? topTags(templates, 12) : []), [templates]);
  const selected = useMemo(() => templates?.find((t) => t.key === selectedKey) ?? null, [templates, selectedKey]);
  const onSelect = useCallback((key: string) => setSelectedKey(key), []);
  const fontProgress = progress && progress.kind === 'fonts' ? progress : null;

  let banner: React.ReactNode = null;
  if (status && !status.available) {
    banner = <div className="memes-banner error">{status.error ?? '模板引擎不可用'}</div>;
  } else if (status && !fontsReady) {
    banner = (
      <div className="memes-banner">
        {fontBusy ? (
          <>
            <Spinner size={14} />
            <span>
              正在下载字体 {fontProgress ? `${fontProgress.done} / ${fontProgress.total}` : ''}
              {fontProgress?.file ? `（${fontProgress.file}）` : ''}
            </span>
            <span className="progress">
              <i style={{ width: fontProgress && fontProgress.total ? `${(fontProgress.done / fontProgress.total) * 100}%` : '0%' }} />
            </span>
          </>
        ) : (
          <>
            <span>
              首次使用需要下载模板用的字体（{status.fontsTotal - status.fontsReady} 个文件，{FONTS_SIZE_HINT}），模板的图片素材会在用到时按需下载。
              {status.error ? ` ${status.error}` : ''}
            </span>
            <button type="button" className="btn sm primary memes-download" onClick={() => void downloadFonts()}>
              <Icon name="download" size={14} /> 下载字体
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <Modal title="用模板做表情" onClose={closeDialog} className="memes">
      {banner}
      {loadError && <div className="memes-banner error">{loadError}</div>}
      <div className="memes-body">
        <div className="memes-gallery">
          <div className="memes-toolbar">
            <div className="search">
              <Icon name="search" className="icon" size={15} />
              <input type="search" value={query} placeholder="搜索模板：摸、喜报、原神…" aria-label="搜索模板" onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="segmented" role="group" aria-label="模板类型">
              {KINDS.map((k) => (
                <button key={k.key} type="button" className={kind === k.key ? 'active' : ''} onClick={() => setKind(k.key)}>
                  {k.label}
                </button>
              ))}
            </div>
            <span className="hint num">{templates ? `${visible.length} / ${templates.length}` : ''}</span>
          </div>
          {tags.length > 0 && (
            <div className="memes-tags">
              {tags.map((x) => (
                <button key={x.tag} type="button" className={`chip${tag === x.tag ? ' active' : ''}`} onClick={() => setTag(tag === x.tag ? '' : x.tag)}>
                  <span className="label">{x.tag}</span>
                  <span className="count num">{x.count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="memes-grid-scroll">
            {!templates ? (
              <div className="memes-empty">{loadError ? loadError : <Spinner size={22} />}</div>
            ) : visible.length === 0 ? (
              <div className="memes-empty">没有符合的模板</div>
            ) : (
              <div className="memes-grid">
                {visible.map((t) => (
                  <TemplateCard key={t.key} template={t} selected={t.key === selectedKey} enabled={fontsReady} onSelect={onSelect} />
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="memes-side">
          {selected ? (
            <TemplateEditor key={selected.key} template={selected} enabled={fontsReady} initialStickerId={stickerId} progress={progress} />
          ) : (
            <div className="memes-empty">
              <div>
                <p>左边挑一个模板，然后选图、填字、生成。</p>
                <p className="hint">模板来自 meme-generator（MemeCrafters），共 {status?.templates ?? templates?.length ?? ''} 个。</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
