import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
  repository?: { url?: string };
};
// GitHub 仓库 owner/name，用于检查更新与“主页”链接
const repo = (pkg.repository?.url ?? '').replace(/^.*github\.com\//, '').replace(/\.git$/, '');

export default defineConfig({
  plugins: [react()],
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __GITHUB_REPO__: JSON.stringify(repo),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome130',
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
