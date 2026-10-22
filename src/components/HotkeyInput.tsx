import { useState, type KeyboardEvent } from 'react';
import { platform } from '../platform';
import { Icon } from '../ui/icons';

interface Props {
  value: string;
  onChange: (accelerator: string) => void;
}

const isMac = platform.os === 'mac';

/** 把 Electron accelerator 显示成本机习惯的写法 */
export function formatHotkey(acc: string): string {
  if (!acc) return '未设置';
  const names: Record<string, string> = isMac
    ? { CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', Super: '⌘' }
    : { CommandOrControl: 'Ctrl', CmdOrCtrl: 'Ctrl', Command: 'Win', Cmd: 'Win', Control: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Option: 'Alt', Shift: 'Shift', Super: 'Win' };
  return acc
    .split('+')
    .map((p) => names[p] ?? p)
    .join(isMac ? ' ' : ' + ');
}

const SPECIAL: Record<string, string> = {
  Space: 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Enter: 'Return',
  NumpadEnter: 'Return',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/** 从按键事件得到 Electron accelerator；不合法（没有修饰键等）时返回 null */
export function acceleratorFromEvent(e: KeyboardEvent | globalThis.KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.metaKey) mods.push(isMac ? 'Command' : 'Super');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  const code = e.code;
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^Numpad[0-9]$/.test(code)) key = 'num' + code.slice(6);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (SPECIAL[code]) key = SPECIAL[code];
  if (!key) return null;
  // 功能键可以单独用，其他键至少要一个修饰键，免得把普通输入抢走
  if (mods.length === 0 && !/^F\d+$/.test(key)) return null;
  // 只有 Shift 修饰的字母/数字也太容易误触
  if (mods.length === 1 && mods[0] === 'Shift' && !/^F\d+$/.test(key)) return null;
  return [...mods, key].join('+');
}

/** 点一下然后按组合键即可录入快捷键 */
export function HotkeyInput({ value, onChange }: Props) {
  const [recording, setRecording] = useState(false);
  const [hint, setHint] = useState('');

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setRecording(false);
      setHint('');
      return;
    }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return; // 只按了修饰键，继续等
    const acc = acceleratorFromEvent(e);
    if (!acc) {
      setHint('需要搭配 Ctrl / Alt / Win 等修饰键，或使用 F1–F12');
      return;
    }
    onChange(acc);
    setRecording(false);
    setHint('');
  };

  return (
    <div className="field">
      <div className="row">
        <button
          type="button"
          className={`btn hotkey${recording ? ' recording' : ''}`}
          onClick={() => {
            setRecording(true);
            setHint('');
          }}
          onBlur={() => setRecording(false)}
          onKeyDown={onKeyDown}
          aria-label="录入快捷键"
        >
          <Icon name="keyboard" size={15} />
          {recording ? '请按下组合键…' : formatHotkey(value)}
        </button>
        {value && (
          <button type="button" className="btn ghost sm" onClick={() => onChange('')}>
            清除
          </button>
        )}
      </div>
      {hint && <div className="error-text">{hint}</div>}
    </div>
  );
}
