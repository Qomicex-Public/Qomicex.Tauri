import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

const here = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1");
const LOGO_SVG = path.resolve(here, "../../public/logo.svg");
const OUT = path.resolve(here, "../remotion/public/textures/logo.png");

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1228, height: 1496, deviceScaleFactor: 1 });

const svgData = fs.readFileSync(LOGO_SVG, "utf8");
const html = `<!DOCTYPE html>
<html><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;width:1228px;height:1496px">
<img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgData)}" style="width:1228px;height:1496px;object-fit:contain" />
</body></html>`;

await page.setContent(html, { waitUntil: "networkidle0" });
await page.screenshot({ path: OUT, omitBackground: true });
console.log("wrote", OUT, fs.statSync(OUT).size, "bytes");
await browser.close();
