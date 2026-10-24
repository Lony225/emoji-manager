import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { flattenTree } from '../../core/selectors';
import { errorMessage } from '../../core/subscription/sync';
import {
  DEFAULT_TEXT_STYLE,
  FONTS,
  STROKE_COLORS,
  TEXT_COLORS,
  TEXT_PRESETS,
  drawTextOverlay,
  type TextAnchor,
  type TextLayout,
  type TextStyle,
} from '../../core/textOverlay';
import { canDecodeAnimation, loadMakerImage, renderWithText, type MakerImage, type MakerSource } from '../../ui/maker';
import { currentCategoryId } from '../../ui/actions';
import { Modal } from '../Dialog';
import { Spinner } from '../../ui/icons';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const ANCHORS: { key: TextAnchor; label: string }[] = [
  { key: 'top', label: '上' },
  { key: 'center', label: '中' },
  { key: 'bottom', label: '下' },
];

function Swatches({ colors, value, onChange, label }: { colors: string[]; value: string; onChange: (c: string) => void; label: string }) {
  const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
  return (
    <div className="swatches" role="group" aria-label={label}>
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          className={`swatch${value.toLowerCase() === c ? ' active' : ''}`}
          style={{ background: c }}
          aria-label={c}
          title={c}
          onClick={() => onChange(c)}
        />
      ))}
      <input type="color" value={hex} aria-label={`${label}：自定义`} title="自定义颜色" onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** 制作表情：在一张图上加文字，保存为新表情 */
export function MakerDialog({ source }: { source: MakerSource }) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const categories = useLibraryStore((s) => s.categories);
  const options = useMemo(() => flattenTree(categories), [categories]);

  const [img, setImg] = useState<MakerImage | null>(null);
  const [loadError, setLoadError] = useState('');
  const [style, setStyle] = useState<TextStyle>(() => ({ ...DEFAULT_TEXT_STYLE }));
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [categoryId, setCategoryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [stageBox, setStageBox] = useState({ w: 0, h: 0 });
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const layoutRef = useRef<TextLayout | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 读入来源图片
  useEffect(() => {
    let alive = true;
    let loaded: MakerImage | null = null;
    loadMakerImage(source).then(
      (m) => {
        if (!alive) {
          m.release();
          return;
        }
        loaded = m;
        setImg(m);
        setCategoryId(m.sticker?.categoryId ?? currentCategoryId() ?? '');
      },
      (e) => {
        if (alive) setLoadError(errorMessage(e));
      },
    );
    return () => {
      alive = false;
      loaded?.release();
      abortRef.current?.abort();
    };
  }, [source]);

  // 预览区大小（图片按比例缩放进去）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setStageBox({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 文字层按原图尺寸画，再用 CSS 缩到预览大小：预览和输出完全一致
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !img) return;
    if (c.width !== img.width || c.height !== img.height) {
      c.width = img.width;
      c.height = img.height;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, c.width, c.height);
    layoutRef.current = drawTextOverlay(ctx, img.width, img.height, style);
  }, [img, style]);

  const fit = useMemo(() => {
    if (!img || !stageBox.w || !stageBox.h) return null;
    const scale = Math.min((stageBox.w - 24) / img.width, (stageBox.h - 24) / img.height, 3);
    return { w: Math.max(1, Math.round(img.width * scale)), h: Math.max(1, Math.round(img.height * scale)) };
  }, [img, stageBox]);

  const defaultName = useMemo(() => {
    const firstLine = style.text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
    return (firstLine || (img ? `${img.baseName} 文字版` : '')).slice(0, 40);
  }, [style.text, img]);
  const shownName = nameEdited ? name : defaultName;
  const animated = !!img && img.frameCount > 1;
  const willBeGif = animated && canDecodeAnimation();

  const patch = (p: Partial<TextStyle>) => setStyle((s) => ({ ...s, ...p }));

  // 在预览里拖动文字
  const fraction = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { fx: (e.clientX - r.left) / Math.max(1, r.width), fy: (e.clientY - r.top) / Math.max(1, r.height) };
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const lay = layoutRef.current;
    if (!img || !lay || e.button !== 0) return;
    const { fx, fy } = fraction(e);
    dragRef.current = { dx: lay.cx / img.width - fx, dy: lay.cy / img.height - fy };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 没有真实指针（测试里合成的事件） */
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const { fx, fy } = fraction(e);
    patch({ anchor: 'custom', x: clamp01(fx + d.dx), y: clamp01(fy + d.dy) });
  };
  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* 已经释放 */
    }
  };

  const save = async () => {
    if (!img || busy) return;
    if (!style.text.trim()) {
      toast('先输入要加的文字', 'error');
      return;
    }
    const finalName = shownName.trim() || '表情';
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setProgress(null);
    try {
      const r = await renderWithText(img, style, {
        signal: ac.signal,
        onProgress: (done, total) => setProgress({ done, total }),
      });
      const target = categoryId || null;
      const result = await useLibraryStore.getState().importFiles(
        [{ name: `${finalName}.${r.ext}`, bytes: r.bytes, displayName: finalName, tags: img.sticker?.tags ?? [], categoryId: target }],
        target,
      );
      if (result.added) {
        toast(`已保存为新表情“${finalName}”${r.ext === 'gif' ? `（GIF，${r.frames} 帧）` : ''}`, 'success');
        closeDialog();
      } else if (result.moved || result.skipped) {
        toast('已经有一张一模一样的表情了', 'info');
      } else {
        toast(result.errors[0] ?? '保存失败', 'error');
      }
    } catch (e) {
      if (!ac.signal.aborted) toast(`制作失败：${errorMessage(e)}`, 'error');
    } finally {
      abortRef.current = null;
      setBusy(false);
      setProgress(null);
    }
  };

  const outputHint = !img
    ? ''
    : willBeGif
      ? `动图 ${img.width}×${img.height} · ${img.frameCount} 帧 · 输出 GIF`
      : `${img.width}×${img.height} · 输出 PNG`;

  return (
    <Modal
      title="制作表情：加文字"
      onClose={closeDialog}
      className="maker"
      footer={
        <>
          <span className="hint left">{outputHint}</span>
          <button className="btn" onClick={closeDialog}>
            取消
          </button>
          <button className="btn primary maker-save" disabled={!img || busy || !style.text.trim()} onClick={() => void save()}>
            {busy ? (
              <>
                <Spinner /> {progress ? `生成中 ${progress.done} / ${progress.total}` : '生成中…'}
              </>
            ) : (
              '保存为新表情'
            )}
          </button>
        </>
      }
    >
      <div className="maker-body">
        <div className="maker-left">
          <div ref={stageRef} className="maker-stage">
            {loadError ? (
              <div className="error-text">{loadError}</div>
            ) : !img || !fit ? (
              <Spinner size={22} />
            ) : (
              <div
                className="maker-frame"
                style={{ width: fit.w, height: fit.h }}
                title="拖动可调整文字位置"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                <img src={img.url} alt="" draggable={false} />
                <canvas ref={canvasRef} />
              </div>
            )}
          </div>
          <div className="hint">
            {animated && !canDecodeAnimation()
              ? '当前环境不能处理动图，保存时只会保留第一帧。'
              : willBeGif
                ? '动图会逐帧加字并重新编成 GIF，保留动画。预览里可以直接拖动文字摆放位置。'
                : '预览里可以直接拖动文字来摆放位置。'}
          </div>
        </div>

        <div className="maker-controls">
          <div className="field">
            <label htmlFor="maker-text">文字</label>
            <textarea
              id="maker-text"
              className="textarea maker-text"
              rows={3}
              value={style.text}
              maxLength={200}
              placeholder="输入要加的文字，可以换行"
              onChange={(e) => patch({ text: e.target.value })}
            />
          </div>

          <div className="field">
            <span className="label">样式</span>
            <div className="maker-presets">
              {TEXT_PRESETS.map((p) => (
                <button key={p.key} type="button" className="chip" onClick={() => patch(p.patch)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="maker-grid">
            <div className="field">
              <span className="label">位置</span>
              <div className="segmented" role="group" aria-label="文字位置">
                {ANCHORS.map((a) => (
                  <button key={a.key} type="button" className={style.anchor === a.key ? 'active' : ''} onClick={() => patch({ anchor: a.key })}>
                    {a.label}
                  </button>
                ))}
                <button type="button" className={style.anchor === 'custom' ? 'active' : ''} disabled title="在预览里拖动文字即可自由摆放">
                  自定义
                </button>
              </div>
            </div>
            <div className="field">
              <span className="label">字体</span>
              <div className="segmented" role="group" aria-label="字体">
                {FONTS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    className={style.font === f.key ? 'active' : ''}
                    style={{ fontFamily: f.family }}
                    onClick={() => patch({ font: f.key })}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="maker-grid">
            <label className="range-row">
              <span>字号</span>
              <input
                type="range"
                min={5}
                max={40}
                value={Math.round(style.sizeRatio * 100)}
                onChange={(e) => patch({ sizeRatio: Number(e.target.value) / 100 })}
                aria-label="字号"
              />
              <span className="num">{Math.round(style.sizeRatio * 100)}%</span>
            </label>
            <label className="range-row">
              <span>描边</span>
              <input
                type="range"
                min={0}
                max={30}
                value={Math.round(style.strokeRatio * 100)}
                onChange={(e) => patch({ strokeRatio: Number(e.target.value) / 100 })}
                aria-label="描边粗细"
              />
              <span className="num">{Math.round(style.strokeRatio * 100)}%</span>
            </label>
          </div>

          <div className="maker-colors">
            <div className="field">
              <span className="label">文字颜色</span>
              <Swatches colors={TEXT_COLORS} value={style.color} onChange={(c) => patch({ color: c })} label="文字颜色" />
            </div>
            <div className="field">
              <span className="label">描边颜色</span>
              <Swatches colors={STROKE_COLORS} value={style.strokeColor} onChange={(c) => patch({ strokeColor: c })} label="描边颜色" />
            </div>
          </div>

          <div className="row maker-toggles">
            <label className="checkbox">
              <input type="checkbox" checked={style.bold} onChange={(e) => patch({ bold: e.target.checked })} />
              加粗
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={style.shadow} onChange={(e) => patch({ shadow: e.target.checked })} />
              阴影
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={style.background} onChange={(e) => patch({ background: e.target.checked })} />
              底色
            </label>
          </div>

          <div className="maker-grid">
            <div className="field">
              <label htmlFor="maker-name">新表情名称</label>
              <input
                id="maker-name"
                className="input"
                value={shownName}
                maxLength={80}
                placeholder="默认用文字的第一行"
                onChange={(e) => {
                  setName(e.target.value);
                  setNameEdited(true);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="maker-category">保存到分类</label>
              <select id="maker-category" className="select" style={{ height: 34 }} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">未分类</option>
                {options.map(({ category: c, depth }) => (
                  <option key={c.id} value={c.id}>
                    {depth ? `${'　'.repeat(depth)}└ ${c.name}` : c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
