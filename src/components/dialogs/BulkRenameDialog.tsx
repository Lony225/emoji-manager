import { useMemo, useState } from 'react';
import { useLibraryStore } from '../../core/store';
import { useUiStore } from '../../ui/uiStore';
import { DEFAULT_RENAME, planRename, type RenameMode, type RenameOptions } from '../../core/rename';
import { useFileUrl } from '../../ui/hooks';
import { Modal } from '../Dialog';

const MODES: { key: RenameMode; label: string }[] = [
  { key: 'number', label: '统一名称 + 序号' },
  { key: 'affix', label: '加前缀 / 后缀' },
  { key: 'replace', label: '查找替换' },
  { key: 'manual', label: '逐个修改' },
];

function Thumb({ file, thumb, alt }: { file: string; thumb?: string; alt: string }) {
  const url = useFileUrl(thumb || file);
  return <img className="mini" src={url} alt={alt} loading="lazy" decoding="async" />;
}

export function BulkRenameDialog({ ids }: { ids: string[] }) {
  const closeDialog = useUiStore((s) => s.closeDialog);
  const toast = useUiStore((s) => s.toast);
  const all = useLibraryStore((s) => s.stickers);
  const stickers = useMemo(() => {
    const order = new Map(ids.map((id, i) => [id, i]));
    return all.filter((s) => order.has(s.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }, [all, ids]);
  const [o, setO] = useState<RenameOptions>(() => ({ ...DEFAULT_RENAME, manual: Object.fromEntries(stickers.map((s) => [s.id, s.name])) }));
  const set = (patch: Partial<RenameOptions>) => setO((prev) => ({ ...prev, ...patch }));
  const plan = useMemo(() => planRename(stickers, o), [stickers, o]);
  const planned = useMemo(() => new Map(plan.map((p) => [p.id, p.name])), [plan]);

  const apply = () => {
    if (plan.length === 0) {
      toast('没有需要改的名字');
      return;
    }
    useLibraryStore.getState().renameMany(plan);
    toast(`已改名 ${plan.length} 个表情`, 'success');
    closeDialog();
  };

  return (
    <Modal
      title={`批量改名（${stickers.length} 个表情）`}
      wide
      onClose={closeDialog}
      footer={
        <>
          <span className="hint left">{plan.length > 0 ? `将改动 ${plan.length} 个` : '暂无改动'}</span>
          <button className="btn" onClick={closeDialog}>
            取消
          </button>
          <button className="btn primary" onClick={apply} disabled={plan.length === 0}>
            改名
          </button>
        </>
      }
    >
      <div className="segmented" role="group" aria-label="改名方式">
        {MODES.map((m) => (
          <button key={m.key} className={o.mode === m.key ? 'active' : ''} onClick={() => set({ mode: m.key })}>
            {m.label}
          </button>
        ))}
      </div>

      {o.mode === 'number' && (
        <form
          className="row rename-form"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <div className="field grow">
            <label htmlFor="rn-base">名称</label>
            <input id="rn-base" className="input" autoFocus value={o.base} placeholder="例如：猫猫" maxLength={70} onChange={(e) => set({ base: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="rn-start">起始序号</label>
            <input id="rn-start" className="input" type="number" min={0} value={o.start} onChange={(e) => set({ start: Number(e.target.value) || 0 })} />
          </div>
          <div className="field">
            <label htmlFor="rn-digits">补零位数</label>
            <input id="rn-digits" className="input" type="number" min={0} max={6} value={o.digits} onChange={(e) => set({ digits: Math.max(0, Math.min(6, Number(e.target.value) || 0)) })} />
          </div>
        </form>
      )}

      {o.mode === 'affix' && (
        <form
          className="row rename-form"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <div className="field grow">
            <label htmlFor="rn-prefix">前缀</label>
            <input id="rn-prefix" className="input" autoFocus value={o.prefix} placeholder="加在名字前面" maxLength={40} onChange={(e) => set({ prefix: e.target.value })} />
          </div>
          <div className="field grow">
            <label htmlFor="rn-suffix">后缀</label>
            <input id="rn-suffix" className="input" value={o.suffix} placeholder="加在名字后面" maxLength={40} onChange={(e) => set({ suffix: e.target.value })} />
          </div>
        </form>
      )}

      {o.mode === 'replace' && (
        <form
          className="field"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <div className="row rename-form">
            <div className="field grow">
              <label htmlFor="rn-find">查找</label>
              <input id="rn-find" className="input" autoFocus value={o.find} placeholder="要替换掉的文字" onChange={(e) => set({ find: e.target.value })} />
            </div>
            <div className="field grow">
              <label htmlFor="rn-replace">替换为</label>
              <input id="rn-replace" className="input" value={o.replaceWith} placeholder="留空即删除" onChange={(e) => set({ replaceWith: e.target.value })} />
            </div>
          </div>
          <div className="row">
            <label className="checkbox">
              <input type="checkbox" checked={o.useRegex} onChange={(e) => set({ useRegex: e.target.checked })} />
              使用正则表达式
            </label>
            <label className="checkbox">
              <input type="checkbox" checked={o.caseInsensitive} onChange={(e) => set({ caseInsensitive: e.target.checked })} />
              忽略大小写
            </label>
          </div>
        </form>
      )}

      <div className="rename-list">
        {stickers.map((s) => (
          <div key={s.id} className={`rename-row${planned.has(s.id) ? ' changed' : ''}`}>
            <Thumb file={s.file} thumb={s.thumb} alt={s.name} />
            {o.mode === 'manual' ? (
              <input
                className="input"
                value={o.manual[s.id] ?? s.name}
                maxLength={80}
                aria-label={`新名字（原名 ${s.name}）`}
                onChange={(e) => set({ manual: { ...o.manual, [s.id]: e.target.value } })}
              />
            ) : (
              <>
                <span className="old" title={s.name}>
                  {s.name}
                </span>
                <span className="arrow">→</span>
                <span className="new" title={planned.get(s.id) ?? s.name}>
                  {planned.get(s.id) ?? s.name}
                </span>
              </>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
