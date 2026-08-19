[简体中文](README.md) | **English** | [繁體中文](README-ZH_TW.md)

<div align="center">
  
<img width="80" height="80" alt="QML Icon" src="/public/logo.svg" />

# Qomicex Minecraft Launcher

[![Stars](https://img.shields.io/github/stars/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&logo=data:image/svg%2bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZlcnNpb249IjEiIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHBhdGggZD0iTTggLjI1YS43NS43NSAwIDAgMSAuNjczLjQxOGwxLjg4MiAzLjgxNSA0LjIxLjYxMmEuNzUuNzUgMCAwIDEgLjQxNiAxLjI3OWwtMy4wNDYgMi45Ny43MTkgNC4xOTJhLjc1MS43NTEgMCAwIDEtMS4wODguNzkxTDggMTIuMzQ3bC0zLjc2NiAxLjk4YS43NS43NSAwIDAgMS0xLjA4OC0uNzlsLjcyLTQuMTk0TC44MTggNi4zNzRhLjc1Ljc1IDAgMCAxIC40MTYtMS4yOGw0LjIxLS42MTFMNy4zMjcuNjY4QS43NS43NSAwIDAgMSA4IC4yNVoiIGZpbGw9IiNlYWM1NGYiLz48L3N2Zz4=&logoSize=auto&label=stars&labelColor=444444&color=eac54f)](https://github.com/Qomicex-Public/Qomicex.Tauri/)
![GitHub Release](https://img.shields.io/github/v/release/Qomicex-Public/Qomicex.Tauri?label=release&logo=github&style=for-the-badge)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/Qomicex-Public/Qomicex.Tauri/ci.yml?style=for-the-badge)

[![Issues](https://img.shields.io/github/issues/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&label=issues&labelColor=444444&color=1F883D&logo=github)](https://github.com/Qomicex-Public/Qomicex.Tauri/issues)
[![Pull requests](https://img.shields.io/github/issues-pr/Qomicex-Public/Qomicex.Tauri?style=for-the-badge&label=pull%20requests&labelColor=444444&color=1F883D&logo=github)](https://github.com/Qomicex-Public/Qomicex.Tauri/pulls)
![GitHub Downloads (all assets, all releases)](https://ghapi.qomicex.top/?style=for-the-badge&color=green)

[![Rust](https://img.shields.io/badge/Rust-stable-000000?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![React 19](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)](https://react.dev)
[![Tauri v2](https://img.shields.io/badge/Tauri-2-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![License: GPLv3](https://img.shields.io/badge/License-GPL%20V3-yellow?style=flat-square)](LICENSE)
[![Release](https://github.com/Qomicex-Public/Qomicex.Tauri/actions/workflows/release.yml/badge.svg)](https://github.com/Qomicex-Public/Qomicex.Tauri/actions/workflows/release.yml)

<div align="center">
  
[Official Website](https://www.qomicex.top)
[Download Latest](https://github.com/Qomicex-Public/Qomicex.Tauri/releases/latest)

</div>

</div>

[Qomicex Minecraft Launcher](https://github.com/Qomicex-Public/Qomicex.Tauri) (QML) is currently in beta — feel free to give it a try.

> The backend has been fully rewritten in Rust (axum). Core libraries and downloader have been migrated to Rust submodules (`qomicex-core-rust` / `qomicex-connector-rust` / `qomicex-downloader-rust`), no longer depending on .NET SDK.

## ✨ Features

> Desktop edition (Tauri v2), with all core logic implemented in Rust.

Qomicex Launcher (QML) aims to make launching, installing, and managing instances as straightforward as possible — whether you're playing daily, installing modpacks, or playing online with friends.

### 🚀 Game Launch

Supports launching vanilla Minecraft and most Mod Loaders with **one-click auto-install**:

- Vanilla
- Forge
- Fabric
- NeoForge
- Quilt
- Babric
- LegacyFabric
- Cleanroom

The launcher reads instance configuration and automatically assembles libraries, assets, natives, JVM arguments, and game parameters. Launch logs are recorded in full for troubleshooting crashes and mod conflicts.

### 🔐 Account Login

Multiple login methods are supported:

- **Microsoft (Premium)** — OAuth device code flow: one-time device code authorization, credentials saved locally for next login
- **Offline player name** — for local testing, single-player, or environments without premium verification
- **Yggdrasil skin servers** — built-in presets for LittleSkin, Blessing Skin, etc.; supports importing other servers

Skin servers support **drag-and-drop link import**: Yggdrasil server addresses are automatically parsed (authlib-injector spec), no manual entry needed.

### 🌐 Built-in Online Play

QML features **Scaffolding Protocol online play** — no public IP needed to play with friends:

- Host / join rooms, NAT type detection (STUN multi-port fallback), relay networking
- **Persistent physical ban on kick**: kicked players cannot rejoin even after reconnecting or restarting
- Accidental kick recovery: reconnection review popup (allow / reject / reject and don't remind again), room owner blacklist with one-click unban
- Host mod verification: missing mods flagged, forced sync when inconsistent
- Compatible with HMCL, PCL-CE, PCL.Mac, and other Scaffolding-compatible launchers

### 📦 Instance Management

Each game version or modpack is stored as an **independent instance** with isolated directories:

- One-click install for versions and loaders (Forge / Fabric / NeoForge / Quilt / etc.)
- Per-instance management: mods, saves, resource packs, shader packs, config files, Java & memory, JVM arguments
- Custom instance groups for organizing large numbers of versions

### 📐 Schematic Management · Deepslate 3D Preview

The instance detail page includes built-in **Litematica schematic** management and preview:

- List / search / open folder / import (multipart, extension whitelist) / rename / single delete + batch delete
- **Deepslate WebGL 3D preview**: view full schematic content + material palette + Y-layer slider + multi-region + block/material statistics
- Materials extracted on-demand from the user's game jar at runtime and cached locally — **no bundled Mojang assets** (copyright compliant)
- Schematics directory included in version isolation, stored per instance

### 🗂️ Resource Center

Aggregates **Modrinth / CurseForge / FTB** data sources for one-stop resource browsing:

- Search mods, modpacks, shaders, resource packs, datapacks, saves
- MC Wiki Chinese name completion for friendlier browsing
- Online search and install for mods, resource packs, shader packs
- One-stop resource detail view

### ⬇️ Download Center

A unified downloader handles game files, libraries, resource files, loader installers, modpacks, and online mod downloads:

- Custom high-speed download engine, multi-file async download, real-time progress per task
- Resume on failure, pause / resume / cancel
- Auto-fallback on slow/failure, source cooldown to avoid hitting rate-limited sources

All download tasks — instance installs, mod downloads, Java runtimes — are managed in one place with full progress and error visibility.

### 📥 Modpack Import / Export

- **Import**: local `zip` / Modrinth `.mrpack` upload, auto-parsed and one-click installed; auto-detects version, loader, mods, config, and resource directories; cleanup on cancel/failure
- **Export**: CurseForge `zip`, Modrinth `mrpack`, or Qomicex-exclusive `.qmodpack`; hash reverse-lookup auto-generates file manifests
- HMCL-style **per-file checkbox export**: custom package name / version / author, async tasks with progress, cancellable, custom save path

### 🧩 Mod Management

Each instance has its own management page:

- View installed mods, enable / disable / delete
- Open instance directory and common folders (mods, saves, resource packs, shader packs, config)
- Online search and install for mods, resource packs, shader packs
- **Mod update check**: Modrinth / CurseForge batch hash matching, change list fed to download center for update orchestration

Disabling a mod preserves the file — only the enabled state changes, making conflict diagnosis easy.

### 📎 Mod Dependency Auto-Install

When installing a mod, QML automatically resolves its **dependency graph** from Modrinth / CurseForge:

- Identifies and displays **required dependencies**, with recursive deep-dependency resolution
- One-click install of prerequisites along with the target mod — no more "missing dependency" errors
- Optional skip for non-required dependencies, choose your install scope

### ☕ Java Runtime Management

Different versions require different Java versions. QML auto-selects the right Java per instance:

- Auto-scan locally installed Java
- Auto-download missing Java 8 / 17 / 21
- Manual Java path selection, per-instance override
- Launch-time Java version validation

### 💾 Save & Game Settings Editor

- **Save settings editor (level.dat NBT)**: visual editing of game mode, difficulty, weather, spawn point, world border, game rules; supports restore from `level.dat_old`
- **Game settings**: visual editing of `options.txt` with multi-language descriptions; array values (resourcePacks / datapacks) managed as chips

### 🩺 Log Analysis & Crash Troubleshooting

After a game crash, the launcher can analyze launch logs:

- **Local rule-based analysis**: 44 built-in error patterns, sorted by Critical > Error > Warning > Info; no extra config needed
- **AI analysis** (plugin-provided): fill in OpenAI-compatible API endpoint, key, and model name

### 🧩 Plugin System

QML offers an extensible plugin ecosystem:

- Manifest contribution points, inline rendering / iframe overlays, inter-plugin method calls
- **L3 WASM plugin gateway** (wasmtime sandbox, written in Rust): plugins run as WebAssembly in a restricted sandbox
- Plugin packages (`.qplugin`) uploaded and installed, state persisted locally

### 🎨 Personalization & Multi-language

- **I18N**: 7 languages — Chinese (Simplified / Traditional) / English (US / GB) / Japanese / Russian, with "follow system" option and real-time switching
- Custom UI font (enumerates system fonts with live preview)
- Built-in / custom background, theme color, and UI personalization options

## 🔗 Dependencies & Related Projects

QML's core capabilities are provided by the following **Rust submodules** (git submodules at repo root, pulled via `git submodule update --recursive`):

- [qomicex-core-rust](https://github.com/Qomicex-Public/qomicex-core-rust) — core library (GameCore, instance / account / Java / download business logic)
- [qomicex-downloader-rust](https://github.com/Qomicex-Public/qomicex-downloader-rust) — unified high-speed downloader
- [qomicex-connector-rust](https://github.com/Qomicex-Public/qomicex-connector-rust) — online play / Scaffolding protocol library (depends on EasyTier4QML fork)
- [Qomicex.Tauri.i18n](https://github.com/Qomicex-Public/Qomicex.Tauri.i18n) — frontend multi-language resource repository

**Partner / Related community project**:

- [EuoraCraft-Launcher (ECLteam)](https://github.com/ECLteam/EuoraCraft-Launcher) — ECLteam's Python + Tauri third-party Minecraft launcher, which **shares online nodes** with QML and is **compatible with the SCF protocol extension** for cross-launcher multiplayer

## 🔗 Links

| Link | URL |
|:--|:--|
| Official Website | <https://www.qomicex.top> |
| Repository | <https://github.com/Qomicex-Public/Qomicex.Tauri> |
| Releases | <https://github.com/Qomicex-Public/Qomicex.Tauri/releases> |
| Issues | <https://github.com/Qomicex-Public/Qomicex.Tauri/issues> |
| i18n Repository | <https://github.com/Qomicex-Public/Qomicex.Tauri.i18n> |
| QQ Test Group | [623362446](https://qm.qq.com/q/rKiwzrkg8w) |

## 🎯 Use Cases

QML is well-suited for:

- Daily Minecraft launching with multiple version and modpack management
- Playing online with friends (no public IP needed, built-in networking)
- Drag-and-drop modpack install / one-click export and share
- Managing mods, resource packs, shader packs, and saves
- Per-instance Java and memory configuration
- Troubleshooting launch failures and crash logs
- A lightweight launcher with a personalized UI and multi-language support

## ℹ️ Pronunciation Guide

Qomicex
/kˈɑːmaɪsˌɛks/
≈ q·om·ic·ex

## 🖥️ Supported Platforms

> Minimum version requirements and test status:

| Platform | Architectures | Minimum OS | Status | Package |
|:---|:---|:---|:---|:---|
| **Windows** | `x64`, `ARM64` | Windows 10 1809+ | ✅ Stable | `.exe` (NSIS installer) |
| **macOS** | `x64` (Intel), `ARM64` (Apple Silicon) | macOS 10.15+ | ✅ Stable | `.dmg` / `.app` |
| **Linux** | `x64`, `ARM64`, `LoongArch64` (untested), `RISC-V 64` (experimental) | Ubuntu 20.04+ / Fedora 34+ / glibc 2.28+ | ✅ Stable | `.deb` / `.rpm` / AppImage |

![Windows](https://img.shields.io/badge/Windows-10%2B-blue?logo=windows)
![macOS](https://img.shields.io/badge/macOS-10.15%2B-black?logo=apple)
![Linux](https://img.shields.io/badge/Linux-Ubuntu%2020.04%2B-yellow?logo=linux)

## 🔧 Development, Debugging & Build

> Tech stack: **Rust** (axum backend + Tauri v2) + **React 19 / Vite / TypeScript** (frontend) + **pnpm** (workspace with `@qomicex/plugin-ui`). Core libraries and i18n resources are pulled as git submodules.

### Prerequisites

- Rust toolchain (stable) + `cargo`; recommended: `rust-analyzer` (editor completion) and `codelldb` (debugging, see `.vscode/launch.json`)
- Node.js + pnpm (workspace management)
- Windows online play build requires npcap (`Packet.dll`) and other runtime dependencies — see `AGENTS.md` and CI `setup-connector-build`

### Initialization (fresh checkout)

```bash
git submodule update --recursive
pnpm install --frozen-lockfile
pnpm --filter @qomicex/plugin-ui build   # plugin-ui dist/ is gitignored; frontend depends on it
```

### Backend Development (Rust API)

```bash
cargo run --manifest-path src-backend/qomicex-backend/Cargo.toml
```

Defaults to `127.0.0.1:5000`; override with `QOMICEX_PORT` env var; debug with VS Code `codelldb`.

### Frontend Development (Vite)

```bash
pnpm run dev        # http://localhost:1420, /api proxied to :5000
```

### Desktop Development (Tauri, integrated window + backend)

```bash
pnpm run tauri dev
```

### Testing

```bash
cargo test --manifest-path src-backend/qomicex-backend/Cargo.toml   # backend unit tests
cd src-tauri && cargo test --lib plugin_gateway                      # Tauri WASM plugin gateway tests
pnpm exec tsc --noEmit                                                # frontend + i18n type check
bash scripts/test-api-filters.sh    # or .ps1; behavioral tests against :5000
```

### Build & Formatting

```bash
pnpm run build    # tsc then vite build; type errors will break the build
cargo fmt         # must run after Rust changes; CI enforces formatting
```

> After editing `packages/plugin-ui/src/`, rebuild the plugin-ui package; i18n changes require a separate commit/push in the `qomicex-tauri-i18n` submodule.

---

## 📄 License

[GPLv3](LICENSE)

## ❤️ Contributors

[![](https://contrib.rocks/image?repo=Qomicex-Public/Qomicex.Tauri)](https://github.com/Qomicex-Public/Qomicex.Tauri/graphs/contributors)
