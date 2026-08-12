// capture-resource-type.mjs — 逐字符真实键入 + 真实过滤采集（B）
// 前置：后端(5000, QOMICEX_HOME=.shots-home) + vite(1420) 运行中
// 输出：video-assets/remotion/public/textures/live/rc-type-*.png + rc-filtered.png + rc-sodium-card.png

import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

const OUT_DIR = "D:/qomicex-launcher/video-assets/remotion/public/textures/live";
const LAYOUT_PATH = "D:/qomicex-launcher/video-assets/remotion/src/layout.json";

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

const QUERY = "sodium";
const TYPE_DELAY_MS = 280; // per-character delay

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.evaluateOnNewDocument(TAURI_MOCK);
await page.setViewport(VIEWPORT);
page.on("pageerror", (e) => console.log(`  pageerror: ${e.message.slice(0, 120)}`));

console.log("navigating to resource-center...");
await page.goto(`${BASE}/resource-center`, { waitUntil: "domcontentloaded", timeout: 30000 });

// wait for initial results to load (real API)
console.log("waiting for initial results...");
await page.waitForSelector("main article, main [class*=group][class*=overflow-hidden], main [class*=space-y]", { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 5000));

// find the search input
const inputHandle = await page.$("input[placeholder*='搜索'], input[type='text'], input");
if (!inputHandle) {
  console.error("ERROR: search input not found");
  await browser.close();
  process.exit(1);
}

// capture initial full page (before typing)
await page.screenshot({ path: `${OUT_DIR}/rc-type-0.png`, fullPage: true });
console.log("captured rc-type-0.png (initial)");

// focus the input
await inputHandle.click();
await new Promise((r) => setTimeout(r, 300));

// type each character, capturing per-char state
const chars = QUERY.split("");
for (let i = 0; i < chars.length; i++) {
  await page.keyboard.type(chars[i], { delay: 0 });
  await new Promise((r) => setTimeout(r, TYPE_DELAY_MS));

  // capture the input element for compositing
  const inputBB = await inputHandle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
  });
  if (inputBB.w > 10) {
    try {
      const clipPath = `${OUT_DIR}/rc-input-${i + 1}.png`;
      await page.screenshot({
        path: clipPath,
        clip: { x: inputBB.x - 4, y: inputBB.y - 4, width: inputBB.w + 8, height: inputBB.h + 8 },
      });
      console.log(`  captured rc-input-${i + 1}.png (${QUERY.slice(0, i + 1)})`);
    } catch (e) {
      console.log(`  input capture miss ${i + 1}: ${e.message.slice(0, 60)}`);
    }
  }

  // also capture full page per char
  await page.screenshot({ path: `${OUT_DIR}/rc-type-${i + 1}.png`, fullPage: true });
  console.log(`  captured rc-type-${i + 1}.png`);
}

// press Enter to trigger real search
console.log("pressing Enter...");
await page.keyboard.press("Enter");

// wait for real filtered results
console.log("waiting for filtered results...");
await new Promise((r) => setTimeout(r, 6000));

// capture filtered full page
await page.screenshot({ path: `${OUT_DIR}/rc-filtered.png`, fullPage: true });
console.log("captured rc-filtered.png");

// capture the sodium card element
const cards = await page.$$("main article, main [class*=group][class*=overflow-hidden]");
let sodiumBB = null;
for (const card of cards) {
  const text = await card.evaluate((el) => el.textContent || "");
  if (text.toLowerCase().includes("sodium")) {
    sodiumBB = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
    });
    if (sodiumBB.w > 10) {
      try {
        await page.screenshot({
          path: `${OUT_DIR}/rc-sodium-card.png`,
          clip: { x: sodiumBB.x, y: sodiumBB.y, width: sodiumBB.w, height: sodiumBB.h },
        });
        console.log(`captured rc-sodium-card.png @${sodiumBB.x},${sodiumBB.y} ${sodiumBB.w}x${sodiumBB.h}`);
      } catch (e) {
        console.log(`sodium card capture miss: ${e.message.slice(0, 60)}`);
      }
    }
    break;
  }
}

if (!sodiumBB) {
  console.log("WARNING: sodium card not found in filtered results");
}

// update layout.json with new entries
const layout = JSON.parse(fs.readFileSync(LAYOUT_PATH, "utf8"));

// update resource-center cutouts to include the sodium card coordinates
if (sodiumBB && layout["resource-center"]) {
  // add rc-sodium-card entry
  layout["resource-center"].cutouts.push({
    file: "rc-sodium-card.png",
    x: sodiumBB.x,
    y: sodiumBB.y,
    w: sodiumBB.w,
    h: sodiumBB.h,
  });
}

fs.writeFileSync(LAYOUT_PATH, JSON.stringify(layout, null, 1));
console.log("wrote", LAYOUT_PATH);

await page.close();
await browser.close();
console.log("done");
