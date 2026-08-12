// capture-light-theme.mjs — 亮色主题截图采集（C）
// 前置：后端(5000, QOMICEX_HOME=.shots-home) + vite(1420) 运行中
// 输出：video-assets/remotion/public/textures/live/*-light-full.png

import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

const OUT_DIR = "D:/qomicex-launcher/video-assets/remotion/public/textures/live";
const BASE = "http://localhost:1420";
const VIEWPORT = { width: 1920, height: 1080, deviceScaleFactor: 2 };
const SETTLE_MS = 800;

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
      if (cmd.includes("theme")) return { theme: "light" };
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

const PAGES = [
  { name: "settings-light", path: "/settings", waitMs: 3000 },
  { name: "dashboard-light", path: "/", waitMs: 4500 },
  { name: "instances-light", path: "/instances", waitMs: 5000 },
];

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({ headless: true });

for (const pg of PAGES) {
  const page = await browser.newPage();

  // inject Tauri mock + set light theme BEFORE any page load
  await page.evaluateOnNewDocument(() => {
    // Tauri mock
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
        if (cmd.includes("theme")) return { theme: "light" };
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
    // set light theme in localStorage
    localStorage.setItem("qomicex-theme", "light");
    // apply .light class on html element
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
  });

  await page.setViewport(VIEWPORT);
  page.on("pageerror", (e) => console.log(`  [${pg.name}] pageerror: ${e.message.slice(0, 100)}`));

  console.log(`navigating to ${pg.path}...`);
  await page.goto(`${BASE}${pg.path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  if (pg.waitMs) await new Promise((r) => setTimeout(r, pg.waitMs));

  // force re-apply light class (in case React reset it)
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
  });
  await new Promise((r) => setTimeout(r, 300));

  const outPath = `${OUT_DIR}/${pg.name}-full.png`;
  await page.screenshot({ path: outPath, fullPage: true });
  console.log(`captured ${pg.name}-full.png`);

  await page.close();
}

await browser.close();
console.log("done");
