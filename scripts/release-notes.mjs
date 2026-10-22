// 从 CHANGELOG.md 里取出某个版本的小节，供 CI 作为 GitHub Release 的说明。
// 用法：node scripts/release-notes.mjs v1.0.0 [输出文件]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = (process.argv[2] ?? '').trim();
const out = process.argv[3];
if (!tag) {
  console.error('用法：node scripts/release-notes.mjs v1.0.0 [输出文件]');
  process.exit(1);
}
const version = tag.replace(/^v/i, '');
const text = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const lines = text.split(/\r?\n/);
const start = lines.findIndex((l) => new RegExp(`^## v?${version.replace(/\./g, '\\.')}(\\s|$)`).test(l));
let notes;
if (start < 0) {
  notes = `发布 ${tag}。详见仓库的 CHANGELOG.md。`;
} else {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  notes = lines.slice(start + 1, end).join('\n').trim();
}
notes += `\n\n---\n未签名的安装包：Windows 上 SmartScreen 提示时点「更多信息 → 仍要运行」；macOS 首次打开在「系统设置 → 隐私与安全性」里点「仍要打开」。`;
if (out) {
  writeFileSync(out, notes);
  console.log(`已写入 ${out}`);
} else {
  process.stdout.write(notes + '\n');
}
