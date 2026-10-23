// Vite config for Puppeteer capture — mocks Tauri APIs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));
const appVersion = pkg.version ?? "0.0.0";

const stub = resolve(__dirname, "video-assets/browser-stub/tauri-stub.mjs");

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  base: "./",
  define: {
    __GIT_SHA__: JSON.stringify("capture"),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/(.*)$/, replacement: stub },
      { find: /^@tauri-apps\/plugin-(.+)$/, replacement: stub },
      { find: '@tauri-apps/api', replacement: stub },
    ],
  },
  optimizeDeps: {
    // 同 vite.config.ts：不显式给入口时 Vite 会 glob 整个仓库的 *.html，
    // 命中 src-tauri/target 下数万个 rustdoc 产物并打爆文件句柄。
    entries: ["index.html"],
    exclude: [
      '@tauri-apps/api',
      '@tauri-apps/api/core',
      '@tauri-apps/api/window',
      '@tauri-apps/api/event',
      '@tauri-apps/plugin-updater',
      '@tauri-apps/plugin-opener',
      '@tauri-apps/plugin-dialog',
      '@tauri-apps/plugin-process',
      '@tauri-apps/plugin-fs',
      '@tauri-apps/plugin-shell',
      '@tauri-apps/plugin-window-state',
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    // 与 vite.config.ts 对齐：optimizeDeps.entries 只约束依赖扫描，管不到 chokidar。
    // 不忽略 target/ 时截图服务器仍会监听 Rust 构建产物（数万条目），拖慢启动。
    watch: {
      ignored: ["**/src-tauri/**", "**/.minecraft/**", "**/.vs/**"],
    },
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
      "/announcements-proxy": {
        target: "https://api.qomicex.top",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/announcements-proxy/, "/api/client/announcements"),
      },
    },
  },
});
