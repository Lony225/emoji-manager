# 项目约定（Claude 在本目录工作时必须遵守）

## 发版
- **不要主动发版。** 不要自行打 `v*` 标签、不要推送标签、不要创建 GitHub Release，也不要替用户决定升级版本号对外发布。只有用户明确说“发版 / 发布 / 打标签”时才做。
- 改完功能的正常收尾是：类型检查、单元测试、端到端测试通过 → 在 `CHANGELOG.md` 顶部记录改动 → 提交并推送到 `main`。本地打包到 `release/` 供用户自测可以做，但那不是发版。
- 发版流程（仅在用户要求时）：改 `package.json` 的 `version`，CHANGELOG 加 `## vX.Y.Z - 日期` 小节，`git tag vX.Y.Z && git push origin main vX.Y.Z`，CI 会构建并发布。

## 协作
- 这个目录可能同时有多个 Claude 会话在工作（例如一个改应用 `src/`，一个改网站 `site/`）。提交时只 `git add` 自己改过的文件，不要 `git add -A`；不要碰别的会话正在改的文件。
- 发现工作区文件内容比 `HEAD` 旧（像被还原成旧快照），先用 `git checkout HEAD -- <文件>` 恢复，再把自己的改动合并上去，不要把旧内容提交回去。

## 验证
- `pnpm typecheck`、`pnpm test`、`pnpm e2e:electron`（真实 Electron，占用 9333 / 8788 端口）。
- 打包：`pnpm exec electron-builder --win nsis portable --config.directories.output=<临时目录>`，再把安装包拷到 `release/`（用户常开着 `release/` 里的程序，直接在 `release/` 打包会被文件锁挡住）。

## 环境
- 直连 GitHub 经常超时：`gh` 用 `HTTPS_PROXY=http://127.0.0.1:7897`，本仓库已配置 `git config http.proxy`。
- GitHub CLI 在 `C:\Program Files\GitHub CLI\gh.exe`（Git Bash 的 PATH 里没有）。
- 用 Write / Edit 工具写代码文件；Bash heredoc 会把 `\\` 吃成 `\`、超长命令会被拒绝。
