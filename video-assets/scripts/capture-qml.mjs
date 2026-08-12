// capture-qml.mjs — Qomicex Launcher 素材采集脚本（三件套）
// 前置：后端(PID在backend.pid, QOMICEX_HOME=.shots-home) + vite dev server 运行中
// 输出：video-assets/textures/live/*.png + video-assets/layout.json

import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

const OUT_DIR = "D:/qomicex-launcher/video-assets/textures/live";
const LAYOUT_JSON = "D:/qomicex-launcher/video-assets/layout.json";

const BASE = "http://localhost:1420";
const VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 2 };
const SETTLE_MS = 700;

// Tauri mock — 浏览器环境没有 Tauri API
const TAURI_MOCK = () => {
  let cbId = 1;
  const callbacks = new Map();
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback(cb, once) { const id = cbId++; callbacks.set(id, cb); return id; },
    unregisterCallback(id) { callbacks.delete(id); },
    invoke: async (cmd) => {
      if (cmd.includes("is_maximized")) return false;
      if (cmd.includes("is_focused")) return true;
      if (cmd.includes("scale_factor")) return 1;
      if (cmd.includes("inner_size")) return { width: 1920, height: 1080 };
      if (cmd.includes("outer_size")) return { width: 1920, height: 1080 };
      if (cmd.includes("theme")) return { theme: "dark" };
      if (cmd.includes("is_visible")) return true;
      if (cmd.includes("title")) return "Qomicex";
      if (cmd.includes("is_fullscreen")) return false;
      if (cmd.includes("is_decorated")) return false;
      if (cmd.includes("is_resizable")) return true;
      if (cmd.includes("current_monitor")) return null;
      if (cmd.includes("primary_monitor")) return null;
      if (cmd.includes("available_monitors")) return [];
      if (cmd.includes("updater")) return null;
      if (cmd.includes("process")) return null;
      if (cmd.includes("listen")) return () => {};
      return null;
    },
    convertFileSrc: (p) => p,
  };
};

// 下载中心假任务（虚构演示数据）
const FAKE_DOWNLOAD_TASKS = [
  { id: "inst-1.20.1-forge", name: "1.20.1-Forge-47.2.0", type: "game", gameVersion: "1.20.1", loader: "Forge", loaderVersion: "47.2.0", status: "completed", progress: 100, totalFiles: 240, completedFiles: 240, createdAt: "2026-08-11T13:40:00.000Z", completedAt: "2026-08-11T13:52:00.000Z", instanceId: "9261b9e0-56b" },
  { id: "inst-1.21.1-fabric", name: "1.21.1-Fabric-0.16.9", type: "game", gameVersion: "1.21.1", loader: "Fabric", loaderVersion: "0.16.9", status: "completed", progress: 100, totalFiles: 96, completedFiles: 96, createdAt: "2026-08-11T13:55:00.000Z", completedAt: "2026-08-11T14:04:00.000Z", instanceId: "b4891faf-a09" },
  { id: "mod-sodium", name: "Sodium 0.6.2", type: "resource", gameVersion: "1.21.1", loader: "Fabric", status: "completed", progress: 100, createdAt: "2026-08-10T14:00:00.000Z", completedAt: "2026-08-10T14:01:00.000Z" },
  { id: "mod-iris", name: "Iris Shaders 1.8.2", type: "resource", gameVersion: "1.21.1", loader: "Fabric", status: "downloading", stage: "downloading", progress: 82, speed: 3.1 * 1024 * 1024, currentFile: "iris-mc1.21.1-1.8.2.jar", totalBytes: 4100000, downloadedBytes: 3362000, createdAt: "2026-08-11T14:15:00.000Z" },
  { id: "java-21", name: "Java 21 (Temurin)", type: "java", gameVersion: "21", status: "queued", progress: 0, createdAt: "2026-08-11T14:20:00.000Z" },
  { id: "mod-optifine", name: "OptiFine HD_U_G8", type: "resource", gameVersion: "1.16.5", status: "failed", progress: 12, error: "文件校验失败，SHA-1 不匹配", createdAt: "2026-08-09T10:00:00.000Z" },
];

const CONFIG = {
  pages: [
    {
      name: "dashboard",
      path: "/",
      waitMs: 4500,
      cutouts: [
        { name: "dash-brand", selector: "h1, p[class*=tracking]" },
        { name: "dash-account", selector: "div[class*=z-50] > div[class*=rounded-xl]" },
        { name: "dash-launch", selector: "div.mt-auto.flex.items-center.justify-between.rounded-2xl" },
      ],
    },
    {
      name: "instances",
      path: "/instances",
      waitMs: 6000,
      cutouts: [
        { name: "inst-grid", selector: "div[class*=grid].anim-stagger, div.anim-stagger" },
        { name: "inst-card", selector: "div[class*=grid].anim-stagger > div", all: true, max: 6 },
      ],
    },
    {
      name: "downloads",
      path: "/downloads",
      waitMs: 4500,
      beforeLoad: (page) => page.evaluate((t) => localStorage.setItem("qomicex-download-tasks", JSON.stringify(t)), FAKE_DOWNLOAD_TASKS),
      cutouts: [
        { name: "dl-task", selector: "div[class*=space-y-3] > div[class*=rounded-xl]", all: true, max: 5 },
      ],
    },
    {
      name: "accounts",
      path: "/accounts",
      waitMs: 4000,
      cutouts: [
        { name: "acc-card", selector: "main div.group.flex.w-full.cursor-pointer", all: true, max: 3 },
      ],
    },
    {
      name: "resource-center",
      path: "/resource-center",
      waitMs: 9000,
      cutouts: [
        { name: "rc-card", selector: "main article, main [class*=group][class*=overflow-hidden]", all: true, max: 4 },
      ],
    },
    {
      name: "connect",
      path: "/connect",
      waitMs: 4000,
      cutouts: [
        { name: "conn-card", selector: "main div[class*=rounded-2xl], main div[class*=rounded-xl] > div", all: true, max: 3 },
      ],
    },
    {
      name: "settings",
      path: "/settings",
      waitMs: 4000,
      cutouts: [
        { name: "set-panel", selector: "main div[class*=rounded-xl]", all: true, max: 4 },
      ],
    },
    {
      name: "account-detail",
      path: "/accounts/e8c33d1c-2f0a-4f8b-9a5c-3f1b9e7a6d21",
      waitMs: 4000,
      cutouts: [
        { name: "acd-skin", selector: "main [class*=rounded-2xl], main [class*=rounded-xl]", all: true, max: 3 },
      ],
    },
  ],
};

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({ headless: true });
const layout = { pageW: VIEWPORT.width };

const settle = async (page) => {
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, SETTLE_MS));
};

for (const pg of CONFIG.pages) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(TAURI_MOCK);
  await page.setViewport(VIEWPORT);
  page.on("pageerror", (e) => console.log(`  [${pg.name}] pageerror: ${e.message.slice(0, 100)}`));

  await page.goto(`${BASE}${pg.path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  if (pg.beforeLoad) await pg.beforeLoad(page);
  await page.goto(`${BASE}${pg.path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await settle(page);
  if (pg.waitMs) await new Promise((r) => setTimeout(r, pg.waitMs));

  const entry = { pageH: await page.evaluate(() => document.documentElement.scrollHeight) };
  layout[pg.name] = entry;

  // 1. 全页 2x 截图
  await page.screenshot({ path: `${OUT_DIR}/${pg.name}-full.png`, fullPage: true });
  console.log(`captured ${pg.name}-full (h=${entry.pageH})`);

  // 2. cutouts
  entry.cutouts = [];
  for (const c of pg.cutouts ?? []) {
    const els = await page.$$(c.selector);
    const picked = c.all ? els.slice(0, c.max ?? els.length) : els.slice(0, 1);
    for (let i = 0; i < picked.length; i++) {
      const file = c.all ? `${c.name}${i + 1}.png` : `${c.name}.png`;
      const bb = await picked[i].evaluate((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
      });
      if (bb.w < 8 || bb.h < 8) continue;
      try {
        await picked[i].screenshot({ path: `${OUT_DIR}/${file}`, omitBackground: !!c.omitBackground });
        entry.cutouts.push({ file, ...bb });
        console.log(`  cutout ${file} @${bb.x},${bb.y} ${bb.w}x${bb.h}`);
      } catch (e) {
        console.log(`  cutout miss ${file}: ${e.message.slice(0, 60)}`);
      }
    }
    if (picked.length === 0) console.log(`  cutout miss ${c.name} (no match)`);
  }

  await page.close();
}

fs.writeFileSync(LAYOUT_JSON, JSON.stringify(layout, null, 1));
console.log("wrote", LAYOUT_JSON);
await browser.close();
