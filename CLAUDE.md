# 项目约定（Claude 在本目录工作时必须遵守）

## 发版
- **不要主动发版。** 不要自行打 `v*` 标签、不要推送标签、不要创建 GitHub Release，也不要替用户决定升级版本号对外发布。只有用户明确说“发版 / 发布 / 打标签”时才做。
- 改完功能的正常收尾是：类型检查、单元测试、端到端测试通过 → 在 `CHANGELOG.md` 顶部记录改动 → 提交并推送到 `main`。本地打包到 `release/` 供用户自测可以做，但那不是发版。
- 发版流程（仅在用户要求时）：改 `package.json` 的 `version`，CHANGELOG 加 `## vX.Y.Z - 日期` 小节，`git tag vX.Y.Z && git push origin main vX.Y.Z`，CI 会构建并发布。

## 协作
- 这个目录可能同时有多个 Claude 会话在工作（例如一个改应用 `src/`，一个改网站 `site/`）。提交时只 `git add` 自己改过的文件，不要 `git add -A`；不要碰别的会话正在改的文件。
- 发现工作区文件内容比 `HEAD` 旧（像被还原成旧快照），先用 `git checkout HEAD -- <文件>` 恢复，再把自己的改动合并上去，不要把旧内容提交回去。

## 验证
- `pnpm typecheck`、`pnpm test`、`pnpm e2e:electron`（真实 Electron，占用 9333 / 9334 / 8788 / 8789 端口）。
- 改了内置更新（`electron/updater.ts`、安装包配置、CI 发布的文件）还要跑 `pnpm e2e:update`：打两个带 E2E 标识的真实安装包装到 `.e2e-tmp` 下的临时目录，走完「应用内下载 → 静默安装 → 自动重启」，跑完自动卸载。它不碰 `release/` 和本机正式安装的程序（`D:\EmojiManager`），但期间别手动打开测试版。
- 打包：`pnpm exec electron-builder --win nsis portable --config.directories.output=<临时目录>`，再把安装包拷到 `release/`（用户常开着 `release/` 里的程序，直接在 `release/` 打包会被文件锁挡住）。
- 安卓：`pnpm dist:android --dev` 打 apk 到 `release/`（文件名带 `-dev-日期`）。脚本自动用 `D:\Android\Android Studio\jbr`（JDK 21；系统 `JAVA_HOME` 是 17，编不了）和 `D:\Android\Sdk`，缺的 SDK 组件 Gradle 自动下载。签名密钥在 `G:\emoji-manager-keys\`（`android-release.jks` + `keystore.properties`，已复制一份到 `android/keystore.properties`，均不入库，丢了就不能覆盖安装了）。
- 安卓真机 / 模拟器验证：`D:\Android\Sdk\platform-tools\adb.exe install -r <apk>`。本机有一个 Android 16 模拟器 `emoji36`（AVD 在 `D:\Android\avd`，启动要设 `ANDROID_AVD_HOME=D:/Android/avd`，`emulator -avd emoji36 -no-window -gpu swiftshader_indirect`，大约 1 分钟开机）。Git Bash 里 adb 的设备路径要加 `MSYS_NO_PATHCONV=1`，否则 `/sdcard/...` 会被改成 Windows 路径；`sdkmanager.bat` 的包名里有分号会被 cmd 拆开，用 `--package_file` 传。调试包（`--debug`）开了 WebView 调试，可以 `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` 后用 CDP 在页面里执行 JS（`.e2e-tmp/android-test/cdp.mjs` 是现成的小工具）；正式包不打日志。
- `android/app/src/main/assets/public`、`capacitor.config.json`、`capacitor.plugins.json`、`res/xml/config.xml` 是 `cap sync` 生成的，不入库；改了 `src/` 要重新 `pnpm android:sync`。

## 环境
- 直连 GitHub 经常超时：`gh` 用 `HTTPS_PROXY=http://127.0.0.1:7897`，本仓库已配置 `git config http.proxy`。
- GitHub CLI 在 `C:\Program Files\GitHub CLI\gh.exe`（Git Bash 的 PATH 里没有）。
- 用 Write / Edit 工具写代码文件；Bash heredoc 会把 `\\` 吃成 `\`、超长命令会被拒绝。
