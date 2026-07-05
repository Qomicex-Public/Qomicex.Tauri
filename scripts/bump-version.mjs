#!/usr/bin/env node
"use strict";

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function usage() {
  console.log("Usage: node scripts/bump-version.mjs <new-version>");
  console.log("  Updates version in: package.json, Cargo.toml, tauri.conf.json, Directory.Build.props");
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

// 4. Directory.Build.props
const propsPath = resolve(ROOT, "src-backend/Directory.Build.props");
if (existsSync(propsPath)) {
  let props = readFileSync(propsPath, "utf-8");
  props = props.replace(/(<Version>)[^<]*(<\/Version>)/, `$1${newVersion}$2`);
  props = props.replace(/(<AssemblyVersion>)[^<]*(<\/AssemblyVersion>)/, `$1${newVersion}.0$2`);
  props = props.replace(/(<FileVersion>)[^<]*(<\/FileVersion>)/, `$1${newVersion}.0$2`);
  props = props.replace(/(<Version>)[^<]*(<\/Version>)/, `$1${newVersion}$2`);
  writeFileSync(propsPath, props);
}

console.log(`Version bumped to ${newVersion}`);
