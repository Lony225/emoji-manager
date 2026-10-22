import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useUiStore } from '../ui/uiStore';
import { Icon } from '../ui/icons';
import { errorMessage } from '../core/subscription/sync';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    // 自动聚焦第一个输入框，没有就聚焦对话框本身
    const first = ref.current?.querySelector<HTMLElement>('input:not([type=checkbox]), textarea, select, button.primary');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h3>{title}</h3>
          <button className="btn ghost icon-only" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

/** 通用的单行输入对话框（新建/重命名分类、重命名标签） */
export function PromptDialog() {
  const dialog = useUiStore((s) => s.dialog);
  const closeDialog = useUiStore((s) => s.closeDialog);
  const [value, setValue] = useState(dialog.kind === 'prompt' ? dialog.value : '');
  const [error, setError] = useState('');
  if (dialog.kind !== 'prompt') return null;

  const submit = async () => {
    const v = value.trim();
    if (!v) {
      setError('请输入内容');
      return;
    }
    try {
      await dialog.onSubmit(v);
      closeDialog();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Modal
      title={dialog.title}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn" onClick={closeDialog}>
            取消
          </button>
          <button className="btn primary" onClick={() => void submit()}>
            {dialog.confirmText ?? '确定'}
          </button>
        </>
      }
    >
      <form
        className="field"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {dialog.label && <label htmlFor="prompt-input">{dialog.label}</label>}
        <input
          id="prompt-input"
          className="input"
          value={value}
          placeholder={dialog.placeholder}
          maxLength={50}
          onChange={(e) => {
            setValue(e.target.value);
            setError('');
          }}
        />
        {error && <div className="error-text">{error}</div>}
      </form>
    </Modal>
  );
}

export function ConfirmDialog() {
  const dialog = useUiStore((s) => s.dialog);
  const closeDialog = useUiStore((s) => s.closeDialog);
  const [checked, setChecked] = useState(dialog.kind === 'confirm' ? !!dialog.checkbox?.checked : false);
  const [busy, setBusy] = useState(false);
  if (dialog.kind !== 'confirm') return null;

  const confirm = async () => {
    setBusy(true);
    try {
      await dialog.onConfirm(checked);
      closeDialog();
    } catch (e) {
      useUiStore.getState().toast(errorMessage(e), 'error');
      setBusy(false);
    }
  };

  return (
    <Modal
      title={dialog.title}
      onClose={closeDialog}
      footer={
        <>
          <button className="btn" onClick={closeDialog}>
            取消
          </button>
          <button className={`btn primary${dialog.danger ? ' danger' : ''}`} disabled={busy} onClick={() => void confirm()}>
            {dialog.confirmText ?? '确定'}
          </button>
        </>
      }
    >
      <p>{dialog.message}</p>
      {dialog.checkbox && (
        <label className="checkbox">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
          {dialog.checkbox.label}
        </label>
      )}
    </Modal>
  );
}
