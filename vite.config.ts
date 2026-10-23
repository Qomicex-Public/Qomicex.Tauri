// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8"));
const appVersion = pkg.version ?? "0.0.0";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(() => ({
  plugins: [react()],
  clearScreen: false,
  base: "./",
  define: {
    __GIT_SHA__: JSON.stringify(process.env.GITHUB_SHA || "unknown"),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  // 依赖预构建的入口显式指定为 index.html。
  //
  // 不指定时 Vite 走 `globEntries("**/*.html")`（config.js 的 computeEntries），
  // 它会遍历整个仓库：本机实测命中 34,635 个 html，其中 34,617 个在
  // `src-tauri/target/` 下（`tauri build --release` 产生的 rustdoc 产物），
  // 逐文件 readFile 会打爆文件句柄上限并报
  // `EMFILE: too many open files ... [plugin vite:dep-scan]`，dev 启动随之变慢。
  //
  // 注意这与 `server.watch.ignored` 是两套机制：那个只管 chokidar 文件监听，
  // 对 dep-scan 的 glob 无效，所以两处都要各自处理。
  optimizeDeps: {
    entries: ["index.html"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/.minecraft/**",
        "**/.vs/**",
        // Rust 构建产物（含 submodule 的 target/）：构建期间替换文件会让 fs.watch 抛 EBUSY，dev server 直接退出
        "**/target/**",
        // gitignored 的本地残留，含 NTFS 保留名，递归遍历会 ENOENT
        "**/src-backend/Qomicex.Launcher.Backend.Neo/**",
      ],
    },
    proxy: {
      "/announcements-proxy": {
        target: "https://api.qomicex.top",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/announcements-proxy/, "/api/client/announcements"),
      },
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
    },
  },
}));
