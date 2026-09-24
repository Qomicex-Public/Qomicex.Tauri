#!/usr/bin/env node

"use strict";

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function usage() {
  console.log("Usage: node scripts/bump-version.mjs <new-version>");
  console.log("  Updates version in: package.json, src-tauri/Cargo.toml, tauri.conf.json,");
  console.log("  src-backend/qomicex-backend/Cargo.toml");
  process.exit(1);
}

const newVersion = process.argv[2];
if (!newVersion) usage();

// 四个文件的 version 必须一起改到：漏一个就会发出版本号互相矛盾的包。
// 后端那个文件不能省——`state::APP_VERSION` 由 env!("CARGO_PKG_VERSION") 编译期注入，
// vendor/UA 里的启动器版本跟随它，release.yml 在构建 backend 前调用本脚本。
const FILES = [
  { path: resolve(ROOT, "package.json"), toml: false },
  { path: resolve(ROOT, "src-tauri/Cargo.toml"), toml: true },
  { path: resolve(ROOT, "src-tauri/tauri.conf.json"), toml: false },
  { path: resolve(ROOT, "src-backend/qomicex-backend/Cargo.toml"), toml: true },
];

for (const file of FILES) {
  const before = readFileSync(file.path, "utf-8");
  let after;
  if (file.toml) {
    after = before.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${newVersion}"`);
    // Cargo.toml 的 version 只在 [package] 段有意义；若文件结构被改坏（字段没了、
    // 缩进改了）导致正则没命中，必须显式失败——否则会静默写出原内容，
    // CI 一路构建出版本号不对的包。
    if (after === before) {
      throw new Error(`未在 ${file.path} 中找到可替换的 version 字段，请检查文件结构`);
    }
  } else {
    after = JSON.stringify({ ...JSON.parse(before), version: newVersion }, null, 2) + "\n";
  }
  if (after !== before) writeFileSync(file.path, after);
}

console.log(`Version bumped to ${newVersion}`);
