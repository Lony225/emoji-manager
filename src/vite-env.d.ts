/// <reference types="vite/client" />

/** 由 vite.config.ts 注入的 package.json 版本号 */
declare const __APP_VERSION__: string;

/** GitHub 仓库 owner/name（由 package.json 的 repository 注入），用于检查更新 */
declare const __GITHUB_REPO__: string;
