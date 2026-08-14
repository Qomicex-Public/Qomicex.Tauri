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
  console.log("  (Directory.Build.props derives its version from package.json)");
  process.exit(1);
}

const newVersion = process.argv[2];
if (!newVersion) usage();

// 1. package.json
const pkgPath = resolve(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// 2. Cargo.toml (src-tauri/)
const cargoPath = resolve(ROOT, "src-tauri/Cargo.toml");
let cargo = readFileSync(cargoPath, "utf-8");
cargo = cargo.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${newVersion}"`);
writeFileSync(cargoPath, cargo);

// 3. tauri.conf.json
const tauriConfPath = resolve(ROOT, "src-tauri/tauri.conf.json");
const tauriConf = JSON.parse(readFileSync(tauriConfPath, "utf-8"));
tauriConf.version = newVersion;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n");

// 4. src-backend/qomicex-backend/Cargo.toml
// 后端 `state::APP_VERSION` 用 `env!("CARGO_PKG_VERSION")`（编译期注入），
// vendor/UA 里的启动器版本跟随此值。release.yml 在构建 backend 前调用本脚本，
// 同步更新后端 crate 版本，保证发布包的 vendor 版本与 package.json 一致。
const backendCargoPath = resolve(ROOT, "src-backend/qomicex-backend/Cargo.toml");
let backendCargo = readFileSync(backendCargoPath, "utf-8");
backendCargo = backendCargo.replace(/^(version\s*=\s*)"[^"]*"/m, `$1"${newVersion}"`);
writeFileSync(backendCargoPath, backendCargo);

// Directory.Build.props derives its version from package.json automatically
// (and strips any pre-release suffix for AssemblyVersion/FileVersion), so it
// must NOT be rewritten here.

console.log(`Version bumped to ${newVersion}`);
