import { useMemo, useState, type KeyboardEvent } from 'react';
import { Icon } from '../ui/icons';

interface Props {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
  placeholder?: string;
  autoFocus?: boolean;
}

function clean(t: string): string {
  return t.trim().replace(/^#/, '').slice(0, 40);
}

/** 标签编辑器：回车 / 逗号添加，退格删除，下面给出已有标签联想 */
export function TagInput({ value, onChange, suggestions, placeholder, autoFocus }: Props) {
  const [text, setText] = useState('');

  const add = (raw: string) => {
    const tags = raw
      .split(/[,，\s]+/)
      .map(clean)
      .filter(Boolean);
    if (tags.length === 0) return;
    onChange(Array.from(new Set([...value, ...tags])));
    setText('');
  };

  const remove = (tag: string) => onChange(value.filter((t) => t !== tag));

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Backspace' && text === '' && value.length > 0) {
      remove(value[value.length - 1]);
    }
  };

  const hints = useMemo(() => {
    const q = text.trim().toLowerCase();
    return suggestions.filter((t) => !value.includes(t) && (!q || t.toLowerCase().includes(q))).slice(0, 14);
  }, [suggestions, value, text]);

  return (
    <div className="field">
      <div className="tag-input" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}>
        {value.map((t) => (
          <span key={t} className="chip active">
            <span className="label">{t}</span>
            <button type="button" className="remove" aria-label={`移除标签 ${t}`} onClick={() => remove(t)}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          value={text}
          autoFocus={autoFocus}
          placeholder={value.length === 0 ? (placeholder ?? '输入标签，回车添加') : ''}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => add(text)}
        />
      </div>
      {hints.length > 0 && (
        <div className="suggest">
          <span className="label">已有标签</span>
          {hints.map((t) => (
            <button key={t} type="button" className="chip" onClick={() => add(t)}>
              <span className="label">{t}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
