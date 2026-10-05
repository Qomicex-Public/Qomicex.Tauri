# 启动器自更新一键链路（独立 Updater + zip 覆盖）

> ADR-067 落地实现。点「立即更新」后全自动：下载中心高速下载 → Qomicex.Updater 校验/覆盖/重启。

## 数据流

```
App.tsx (启动 5s 后台检查 / Settings 手动检查)
  → GET /api/update/plan                       (本地后端)
      → https://api.qomicex.top/api/client/update/plan   (Web.Backend, 灰度门控)
  ← { hasUpdate, version, strategy, packageUrl, signature, changelog, required }
  → UpdateDialog 弹窗（含 changelog / 强制更新标记）
  → 点「立即更新」:
      1. updaterStore.start(plan)
      2. POST /api/plugins/download/start        (targetPath={dataDir}/updates/qomicex-update-{v}.zip)
         → 共享 DownloadManager，任务出现在下载中心（SSE 进度）
      3. 轮询 GET /api/plugins/download/{taskId}/progress
      4. completed → invoke('run_updater', { packagePath, signature, version })
         （src-tauri/src/updater.rs：释放内嵌 updater.exe → 写签名文件 → 检测 strategy/install-dir →
          detached spawn（--wait-pid 当前进程）→ app.exit(0)，RunEvent::Exit 收尾 backend）
  → Qomicex.Updater（独立仓库/submodule）:
      minisign 校验（公钥内嵌）→ 等 pid 退出 → 按 strategy 覆盖 → --launch 拉起新版 → 退出
```

## 端点

| 端点 | 位置 | 说明 |
|---|---|---|
| GET /api/update/plan | src-backend .../endpoints/update.rs | 本机检测 os/arch/mode 转发 upstream；204→hasUpdate=false；包 URL 套代理竞速 |
| GET /api/client/update/plan | Web.Backend api/src/routes/client/update-plan.ts | versions.weight+machineHash 取模灰度（weight=0 全量止损）；选 qomicex-update-<key>.zip 条目 |
| /api/update/manifest | update.rs | 旧 Tauri updater 格式，仅服务存量旧版，不再被本版消费 |

## 平台矩阵（更新包 qomicex-update-<key>.zip + .sig）

| key | strategy | 包内容 | 覆盖动作 | 提权 |
|---|---|---|---|---|
| windows-x86_64 / windows-aarch64 | dir | NSIS /S /D= 安装后目录内容 | 解压覆盖安装根 | 无 |
| linux-{arch}-appimage | appimage | AppImage 本体 | 整文件替换 + 0755 | 无 |
| linux-{arch}-system | system | deb 层级（dpkg-deb -x） | pkexec 覆盖 / | polkit 弹窗 |
| darwin-x86_64 / darwin-aarch64 | app | .app 内部内容 | osascript 提权覆盖 bundle（可写则直写） | admin 弹窗 |

mode 检测：linux 且 $APPIMAGE 未设置 → system；其余平台 mode 忽略。

## Updater CLI 契约（Qomicex.Updater）

```
qomicex-updater --package <zip> --signature <sig> --strategy <dir|appimage|app|system>
  [--install-dir <p>] [--appimage <p>] [--app-bundle <p>] [--wait-pid <pid>] [--launch <exe>]
```
退出码：0 成功 / 1 用法 / 2 IO / 3 签名无效 / 4 策略失败 / 5 等待超时。
签名：minisign 公钥（`35DD6AE53301ABE3`）编译期内嵌 src/main.rs；CI 用 `npx tauri signer sign`（同一 keypair）。

## CI（release.yml / debug.yml 同构）

每个平台 job：构建 Qomicex.Updater submodule → 复制到 src-tauri/binaries/（updater.exe/updater，include_bytes）→
tauri build → 「Generate self-update package」静默安装/解包收集 → zip → signer sign → upload-artifact。
release job：update-package-fragment-*.json 合并 updates.json，与 zip/sig 一并上传 Release；latest.json 保留。

## 本地验证

- `cargo test --manifest-path Qomicex.Updater/Cargo.toml`（1 个：坏签名拒绝 + exit 3）
- `cargo test --manifest-path src-tauri/Cargo.toml`（version_order 回归 2 例 + 网关 7 例）
- dev 无嵌入二进制时 updater 解析顺序：QOMICEX_UPDATER_PATH env → 兄弟仓库 target/{release,debug}/
- 全链路（下载→覆盖→重启）需 release 构建或双机实测；updates.json 结构可用 `bash scripts/test-api-filters.sh` 风格 curl 断言

## 安全边界

- 签名无效 → updater 拒绝动手（exit 3），测试锁定
- zip 提取拒绝 `..` 路径（mangled_name）
- 覆盖先 staging 再 move（同卷 rename 原子）；提权脚本临时文件用后即删
- 灰度门控在服务端（weight），客户端不参与决策


### 2026-09-07 更新
# 启动器自更新一键链路（独立 Updater + zip 覆盖）

> ADR-067 落地实现。点「立即更新」后全自动：下载中心高速下载 → Qomicex.Updater 校验/覆盖/重启。

## 数据流

```
App.tsx (启动 5s 后台检查 / Settings 手动检查)
  → GET /api/update/plan?channel=...           (本地后端)
      → https://api.qomicex.top/api/client/update/plan   (Web.Backend, 灰度门控)
  ← { hasUpdate, version, strategy, packageUrl, signature, changelog, required }
  → UpdateDialog 弹窗（含 changelog / 强制更新标记）
  → 点「立即更新」:
      1. updaterStore.start(plan)
      2. POST /api/plugins/download/start        (targetPath={dataDir}/updates/qomicex-update-{v}.zip)
         → 共享 DownloadManager，任务出现在下载中心（SSE 进度）
      3. 轮询 GET /api/plugins/download/{taskId}/progress
      4. completed → invoke('run_updater', { packagePath, signature, version })
         （src-tauri/src/updater.rs：释放内嵌 updater.exe → 写签名文件 → 检测 strategy/install-dir →
          detached spawn（--wait-pid 当前进程）→ app.exit(0)，RunEvent::Exit 收尾 backend）
  → Qomicex.Updater（独立仓库/submodule）:
      minisign 校验（公钥内嵌）→ 等 pid 退出 → 按 strategy 覆盖 → 拉起新版 → 退出
```

## 端点

| 端点 | 位置 | 说明 |
|---|---|---|
| GET /api/update/plan?channel= | src-backend .../endpoints/update.rs | 本机检测 os/arch/mode 转发 upstream（channel 传透）；204→hasUpdate=false；包 URL 套代理竞速 |
| GET /api/client/update/plan | Web.Backend api/src/routes/client/update-plan.ts | versions.weight+machineHash 取模灰度（weight=0 全量止损）；**只认 `update-` 前缀键**（见下）；target=darwin/windows/linux |
| /api/update/manifest | update.rs | 旧 Tauri updater 格式，仅服务存量旧版，不再被本版消费 |

## 平台键语义（2026-09-07 修复）

DB `versions.platforms` 里**两套键空间并存**：
- Tauri manifest 键（`windows-x86_64`、`darwin-aarch64`…）：setup.exe/dmg/AppImage 资产，供 legacy `/manifest`
- 自更新包键（`update-windows-x86_64`、`update-linux-x86_64-system`…）：由 `qomicex-update-<key>.zip` 资产同步生成，仅 `/plan` 消费

> 键冲突教训：曾共用键名，tauri 循环后写覆盖了 update 包条目，线上 /plan 误把 NSIS setup.exe 当文件布局包发出去（strategy=dir + setup.exe URL，updater 解压必炸）。修法 = update- 前缀隔离 + darwin 映射修复（本地后端 target 是 `std::env::consts::OS` 改写后的 "darwin"，不含 "apple" 字样）。

## 平台矩阵（更新包 qomicex-update-<key>.zip + .sig）

| 包名 key（资产） | strategy | 包内容 | 覆盖动作 | 提权 |
|---|---|---|---|---|
| windows-x86_64 / windows-aarch64 | dir | NSIS /S /D= 安装后目录内容 | 解压覆盖安装根 | 无 |
| linux-{arch}-appimage | appimage | AppImage 本体 | 整文件替换 + 0755 | 无 |
| linux-{arch}-system | system | deb 层级（dpkg-deb -x） | 解压覆盖 / | polkit 弹窗 |
| darwin-x86_64 / darwin-aarch64 | app | .app 内部内容 | osascript 提权覆盖 bundle（可写则直写） | admin 弹窗 |

mode 检测：linux 且 $APPIMAGE 未设置 → system；其余平台 mode 忽略。

## Updater CLI 契约（Qomicex.Updater）

```
qomicex-updater --package <zip> --signature <sig> --strategy <dir|appimage|app|system>
  [--install-dir <p>] [--appimage <p>] [--app-bundle <p>] [--wait-pid <pid>] [--launch <exe>]
```
退出码：0 成功 / 1 用法 / 2 IO / 3 签名无效 / 4 策略失败 / 5 等待超时。
签名：minisign 公钥（`35DD6AE53301ABE3`）编译期内嵌 src/main.rs；CI 用 `npx tauri signer sign`（同一 keypair）。

## CI（release.yml / debug.yml 同构）

每个平台 job：构建 Qomicex.Updater submodule → 复制到 src-tauri/binaries/（updater.exe/updater，include_bytes）→
tauri build → 「Generate self-update package」静默安装/解包收集 → zip → signer sign → upload-artifact。
release job：update-package-fragment-*.json 合并 updates.json，与 zip/sig 一并上传 Release；latest.json 保留。

## 本地验证

- `cargo test --manifest-path Qomicex.Updater/Cargo.toml`（1 个：坏签名拒绝 + exit 3）
- `cargo test --manifest-path src-tauri/Cargo.toml`（version_order 回归 2 例 + 网关 7 例）
- Web.Backend `pnpm --filter @qomicex/api test`（43 例，含 platformKey darwin 回归）
- dev 无嵌入二进制时 updater 解析顺序：QOMICEX_UPDATER_PATH env → 兄弟仓库 target/{release,debug}/
- 全链路（下载→覆盖→重启）需 release 构建或双机实测

## 安全边界

- 签名无效 → updater 拒绝动手（exit 3），测试锁定
- zip 提取拒绝 `..` 路径（mangled_name）；version 先 semver 校验再进文件名（防路径穿越）
- 覆盖先 staging 再 move（同卷 rename 原子）；提权脚本临时文件用后即删
- 灰度门控在服务端（weight），客户端不参与决策

## ⚠️ 部署状态（2026-09-07）

Web.Backend deploy.yml（master push 自动部署）自 2026-08-25 起无一次成功：
`Cloudflare API (/memberships) failed. Authentication failed (status: 400) [code: 9106]`。
线上 /plan 为手动本地部署的旧版。修复生效需手动 `pnpm deploy:api` 或修复 GH secret `CLOUDFLARE_API_TOKEN`。



### 2026-09-09 更新
# 启动器自更新一键链路（独立 Updater + zip 覆盖）

> ADR-067 落地实现。点「立即更新」后全自动：下载中心高速下载 → Qomicex.Updater 校验/覆盖/重启。

## 数据流

```
App.tsx (启动 5s 后台检查 / Settings 手动检查)
  → GET /api/update/plan?channel=...           (本地后端)
      → https://api.qomicex.top/api/client/update/plan   (Web.Backend, 灰度门控)
  ← { hasUpdate, version, strategy, packageUrl, signature, changelog, required }
  → UpdateDialog 弹窗（含 changelog / 强制更新标记）
  → 点「立即更新」:
      1. updaterStore.start(plan)
      2. POST /api/plugins/download/start        (targetPath={dataDir}/updates/qomicex-update-{v}.zip)
         → 共享 DownloadManager，任务出现在下载中心（SSE 进度）
      3. 轮询 GET /api/plugins/download/{taskId}/progress
      4. completed → invoke('run_updater', { packagePath, signature, version })
         （src-tauri/src/updater.rs：释放内嵌 updater.exe → 写签名文件 → 检测 strategy/install-dir →
          detached spawn（--wait-pid 当前进程）→ app.exit(0)，RunEvent::Exit 收尾 backend）
  → Qomicex.Updater（独立仓库/submodule）:
      minisign 校验（公钥内嵌）→ 等 pid 退出 → 按 strategy 覆盖 → 拉起新版 → 退出
```

## 端点

| 端点 | 位置 | 说明 |
|---|---|---|
| GET /api/update/plan?channel= | src-backend .../endpoints/update.rs | 本机检测 os/arch/mode 转发 upstream（channel 传透）；204→hasUpdate=false；包 URL 套代理竞速 |
| GET /api/client/update/plan | Web.Backend api/src/routes/client/update-plan.ts | versions.weight+machineHash 取模灰度（weight=0 全量止损）；**只认 `update-` 前缀键**；target=darwin/windows/linux |
| /api/update/manifest | update.rs | 旧 Tauri updater 格式，仅服务存量旧版 |

## 平台键语义

DB `versions.platforms` 两套键空间并存：Tauri manifest 键（legacy /manifest）与自更新包键（`update-` 前缀，仅 /plan 消费）。键曾共用导致 tauri 条目覆盖 update 包条目（线上误发 setup.exe），已隔离。

## 平台矩阵（更新包 qomicex-update-<key>.zip + .sig）

| 包名 key | strategy | 包内容 | 覆盖动作 | 提权 |
|---|---|---|---|---|
| windows-x86_64 / windows-aarch64 | dir | NSIS /S /D= 安装后目录内容 | 解压覆盖安装根 | 无 |
| linux-{arch}-appimage | appimage | AppImage 本体 | 整文件替换 + 0755 | 无 |
| linux-{arch}-system | system | deb 层级（dpkg-deb -x） | 解压覆盖 / | polkit 弹窗 |
| darwin-x86_64 / darwin-aarch64 | app | .app 内部内容 | osascript 提权覆盖 bundle | admin 弹窗 |

## 空签名自愈（beta23 事故修复）

**事故链**：release publish 触发 sync 时部分 .sig 资产尚未就绪（实测 windows sig 晚 15min）→ `fetchSignature` 静默吞 404 → `signature:""` 入库 → `/plan` 对空签名恒 204（用户见「已是最新版」）→ 旧 sync 对已存在 release 恒跳过，空签名永久固化。

**修复**（Web.Backend b04542b）：`syncGithubVersions` 对已存在行检测 `platformsHaveEmptySignature` → 重建 platforms 并补齐（重建后仍空则不动，防抖动）。自愈触发条件 = 空签名条目存在；重拉一次的成本可接受。

**关联回归**：PR #88 改 launcher artifact path 时误删 `**/*.exe.sig` → beta22/23 无 setup.exe.sig → legacy /manifest windows 条目空签名 → 本地后端 retain 丢弃 → 存量旧版客户端失去 windows 更新。已在 main 5512af5 恢复（release.yml + debug.yml）。

**存量修复操作**：部署新版后触发一次 sync 即可补齐 beta22/23：
```
curl -X POST https://api.qomicex.top/api/internal/releases/sync \
  -H "Authorization: Bearer $RELEASE_SYNC_TOKEN"
```

## Updater CLI 契约（Qomicex.Updater）

```
qomicex-updater --package <zip> --signature <sig> --strategy <dir|appimage|app|system>
  [--install-dir <p>] [--appimage <p>] [--app-bundle <p>] [--wait-pid <pid>] [--launch <exe>]
```
退出码：0 成功 / 1 用法 / 2 IO / 3 签名无效 / 4 策略失败 / 5 等待超时。

## 本地验证

- Web.Backend `pnpm --filter @qomicex/api test`（45 例：plan 键/darwin 回归/空签名自愈触发）
- `cargo test`（backend 122 / src-tauri 9 / updater 1）
- 全链路（下载→覆盖→重启）需 release 构建或双机实测

## ⚠️ 部署状态（2026-09-09 更新）

Web.Backend deploy.yml 仍持续失败：`Cloudflare API Authentication failed (status: 400) [code: 9106]`。
自愈修复（b04542b）已推未部署——**修复生效必须先修部署**（GH secret `CLOUDFLARE_API_TOKEN` 或本地 `pnpm deploy:api`），随后手动触发一次 sync。



### 2026-09-10 更新
# 自更新安装全流程规格（释放物/路径/参数全量）

> 对应 ADR-067。本文为运行时规格：每个环节跑了什么程序、完整参数、写了哪些文件到哪里。
> 路径占位：`<INST>`=安装根（Windows 默认 `%LOCALAPPDATA%\Qomicex Launcher`）；`<TMP>`=`%LOCALAPPDATA%\Temp\qomicex`；`<DATA>`=backend settings 的 dataDir（用户可改，如 `C:\qomicex-launcher`）；`<VER>`=目标版本号（如 `0.1.0-beta23.0`）。

## 阶段 0：检查更新

| 步 | 动作 | 位置/参数 |
|---|---|---|
| 0.1 | 前端 `fetchUpdatePlan(channel)` | App.tsx 启动 5s 后 / Settings 手动 |
| 0.2 | `GET /api/update/plan?channel=` | 本地 backend（`<TMP>\qomicex-backend.exe`，env `QOMICEX_IPC_PIPE=\\.\pipe\qomicex-backend-<pid>` `QOMICEX_NO_TCP=1`，CREATE_NO_WINDOW） |
| 0.3 | 转发 `https://api.qomicex.top/api/client/update/plan` | query: `current=<壳 APP_VERSION> target=<consts::OS> arch=<consts::ARCH> mode=<linux: $APPIMAGE 无→system> channel=<透传>` |
| 0.4 | upstream 灰度裁决（weight+machineHash）→ 200 plan / 204 | update-plan.ts；packageUrl 套 gh-proxy 竞速前缀（本地后端 L117） |
| 返回 | `{hasUpdate,version,strategy,packageUrl,signature,changelog,required}` | signature=minisign armor 的 base64 包裹（tauri signer 格式） |

## 阶段 1：下载（下载中心任务）

| 步 | 动作 | 位置/参数 |
|---|---|---|
| 1.1 | `POST /api/plugins/download/start` | body `{url: packageUrl, targetPath: "<DATA>/updates/qomicex-update-<VER>.zip"}`（updaterStore.ts:42-46） |
| 1.2 | backend `DownloadManager.add(task)` 多线程下载 | 落盘 `<DATA>/updates/qomicex-update-<VER>.zip`（暂存 `.qdtmp` 后缀，完成 rename） |
| 1.3 | session 进下载中心 SSE | session_json type=resource |
| 1.4 | 前端轮询 `GET /api/plugins/download/{taskId}/progress` | 1s 间隔；completed→阶段 2；failed/cancelled→error |

## 阶段 2：交接（Tauri 壳内，src-tauri/src/updater.rs）

| 步 | 动作 | 位置/参数 |
|---|---|---|
| 2.1 | `invoke('run_updater', {packagePath, signature, version})` | updaterStore.ts:27-30 |
| 2.2 | extract_updater()：release 走 `include_bytes!("../binaries/updater.exe")` → 写 `<TMP>\qomicex-updater.exe`；dev：`QOMICEX_UPDATER_PATH` env > 兄弟仓库 target/{release,debug} | unix chmod 755 |
| 2.3 | version semver 校验（剥 `v`）→ 防路径穿越 | INVALID_VERSION 短路 |
| 2.4 | 签名落盘：写 `<TMP>\qomicex-update-<VER>.sig`（内容=plan.signature 原文） | |
| 2.5 | detect_strategy()：windows→`dir`+`--install-dir <壳exe父目录>`；macos→`app`+`--app-bundle`；linux→`$APPIMAGE`有→`appimage`+`--appimage`，无→`system` | |
| 2.6 | `--launch <current_exe>`（当前壳 exe 全路径） | |
| 2.7 | `--wait-pid <launcher pid>`（`std::process::id()`） | |
| 2.8 | spawn updater（DETACHED_PROCESS\|CREATE_NEW_PROCESS_GROUP\|CREATE_NO_WINDOW）| **完整命令行**见下 |
| 2.9 | sleep 300ms → `app.exit(0)` → RunEvent::Exit：kill 内嵌 backend + wait | tauri log `[updater] spawned` |

**阶段 2.8 完整命令行**（Windows 实例）：
```text
%LOCALAPPDATA%\Temp\qomicex\qomicex-updater.exe
  --package    C:\qomicex-launcher\updates\qomicex-update-0.1.0-beta23.0.zip
  --signature  %LOCALAPPDATA%\Temp\qomicex\qomicex-update-0.1.0-beta23.0.sig
  --strategy   dir
  --install-dir "C:\Users\<u>\AppData\Local\Qomicex Launcher"
  --wait-pid   <launcher pid>
  --launch     "C:\Users\<u>\AppData\Local\Qomicex Launcher\Qomicex Launcher.exe"
```

## 阶段 3：updater 执行（Qomicex.Updater，独立无 GUI 进程）

| 步 | 动作 | 失败退出码 |
|---|---|---|
| 3.0 | ulog 落盘：`<TMP>\qomicex\qomicex-updater-<pid>.log`（start/verify/wait/install/launch/done 全节点 + rename 失败明细） | — |
| 3.1 | minisign 校验 zip 全文（公钥 `35DD6AE53301ABE3` 内嵌；sig 兼容 base64 包裹/裸 armor） | 3 |
| 3.2 | wait_process_exit(--wait-pid)：tasklist 轮询 500ms，上限 180s（launcher 退出实测可慢） | 5 |
| 3.3 | dir 策略 install_dir：staging=`<INST>` 同卷父级 `.dir-update-tmp-Qomicex Launcher` → zip 解压到 staging（mangled_name 防穿越，unix 保留 mode）→ move_tree 逐项 remove+rename 到 `<INST>` → 清 staging | 2 |
| 3.4 | launch：先剥 `QOMICEX_LAUNCHER_MANAGED`/`QOMICEX_UPDATER_PATH` env → `Command::new(--launch 值)` + DETACHED\|NEW_GROUP | 2 |
| 3.5 | done，进程退出 | 0 |

**覆盖后的 `<INST>` 内容**（= zip 内容 = NSIS 安装布局）：`Qomicex Launcher.exe`（新壳，内嵌新 backend）+ `uninstall.exe` +（CI 收集目录里的 Packet.dll/wintun.dll 若有）。**不含独立 qomicex-backend.exe**（backend 嵌壳运行时释放）。

## 阶段 4：新壳启动

| 步 | 动作 |
|---|---|
| 4.1 | 新版壳（`<INST>\Qomicex Launcher.exe`）启动 → extract_backend：写 `<TMP>\qomicex-backend.exe` + Packet.dll + wintun.dll |
| 4.2 | spawn backend：env `QOMICEX_IPC_PIPE=\\.\pipe\qomicex-backend-<pid>` + `QOMICEX_NO_TCP=1`，CREATE_NO_WINDOW，stdout/stderr piped → `{BaseDir}/logs/qomicex-backend.log` |
| 4.3 | 前端 initApiTransport 探测 qomicex:// 管道成功 → 正常运行（关于页显示新版本号） |

## 退出码表（qomicex-updater）

`0` 成功 | `1` 用法错误 | `2` IO/启动失败 | `3` 签名无效 | `4` 策略失败（system/app） | `5` 等待超时

## 可观测性

- launcher 侧：tauri log `[updater] spawned (strategy=…, package=…)`（`{BaseDir}/logs/qomicex-tauri.log`）
- updater 侧：`<TMP>\qomicex\qomicex-updater-<pid>.log`（全节点）
- 下载：下载中心 SSE + `GET /api/plugins/download/{taskId}/progress`

## 已知事故史（回归防护）

1. sig 为 base64 包裹格式未兼容 → exit 3（27b40ed 修）
2. wait 30s 超时（launcher 退出实测慢）→ exit 5 → install/launch 全跳（e0b8901 修：180s）
3. MANAGED/UPDATER_PATH env 被新壳继承 → 新壳不自管 backend（e0b8901 修：launch 前剥离）
4. version 未校验直进文件名（安全）（faec8e8 修）



### 2026-09-10 更新
# 自更新安装全流程规格（释放物/路径/参数全量）

> 对应 ADR-067。本文为运行时规格：每个环节跑了什么程序、完整参数、写了哪些文件到哪里。
> 路径占位：`<INST>`=安装根（Windows 默认 `%LOCALAPPDATA%\Qomicex Launcher`）；`<TMP>`=`%LOCALAPPDATA%\Temp\qomicex`；`<DATA>`=backend settings 的 dataDir（用户可改，如 `C:\qomicex-launcher`）；`<VER>`=目标版本号（如 `0.1.0-beta23.0`）；`<UPD>`=`<DATA>\updates`（更新域：包+updater+sig 同目录）。
> 日志域：壳/launcher 侧 → `{BaseDir}\logs\qomicex-tauri.log`；backend → `{BaseDir}\logs\qomicex-backend.log`；**updater → `<DATA>\log\qomicex-updater-<pid>.log`**（`<UPD>` 的 `../log/`，由壳以 `--log` 传入）。

## 阶段 0：检查更新

| 步 | 动作 | 位置/参数 |
|---|---|---|
| 0.1 | 前端 `fetchUpdatePlan(channel)` | App.tsx 启动 5s 后 / Settings 手动 |
| 0.2 | `GET /api/update/plan?channel=` | 本地 backend（`<TMP>\qomicex-backend.exe`，env `QOMICEX_IPC_PIPE=\\.\pipe\qomicex-backend-<pid>` `QOMICEX_NO_TCP=1`，CREATE_NO_WINDOW） |
| 0.3 | 转发 `https://api.qomicex.top/api/client/update/plan` | query: `current=<壳 APP_VERSION> target=<consts::OS> arch=<consts::ARCH> mode=<linux: $APPIMAGE 无→system> channel=<透传>` |
| 0.4 | upstream 灰度裁决（weight+machineHash）→ 200 plan / 204 | update-plan.ts；packageUrl 套 gh-proxy 竞速前缀（本地后端 L117） |
| 返回 | `{hasUpdate,version,strategy,packageUrl,signature,changelog,required}` | signature=minisign armor 的 base64 包裹（tauri signer 格式） |

## 阶段 1：下载（下载中心任务）

| 步 | 动作 | 位置/参数 |
|---|---|---|
| 1.1 | `POST /api/plugins/download/start` | body `{url: packageUrl, targetPath: "<UPD>/qomicex-update-<VER>.zip"}`（updaterStore.ts） |
| 1.2 | backend `DownloadManager.add(task)` 多线程下载 | 落盘 `<UPD>/qomicex-update-<VER>.zip`（暂存 `.qdtmp` 后缀，完成 rename） |
| 1.3 | session 进下载中心 SSE | session_json type=resource |
| 1.4 | 前端轮询 `GET /api/plugins/download/{taskId}/progress` | 1s 间隔；completed→阶段 2；failed/cancelled→error |

## 阶段 2：交接（Tauri 壳内，src-tauri/src/updater.rs）

壳侧每一步（stage1-6）以**实际求值**写入 tauri log（tag `[updater]`），每步写后 `flush_log()`（write+sync_all）；`app.exit(0)` 前再总 flush——detached updater 启动前的壳侧观测全程可见。

| 步 | 动作 | 位置/参数 |
|---|---|---|
| 2.1 | `invoke('run_updater', {packagePath, signature, version})` | updaterStore.ts；updatesDir 由 packagePath.parent() 推导 |
| 2.2 | extract_updater(updatesDir)：release 走 `include_bytes!("../binaries/updater.exe")` → **写 `<UPD>\qomicex-updater.exe`**；dev：`QOMICEX_UPDATER_PATH`/兄弟仓库构建产物**统一复制落位** `<UPD>` | unix chmod 755；dev 源不可复制时回退原路径 |
| 2.3 | version semver 校验（剥 `v`）→ 防路径穿越 | INVALID_VERSION 短路 |
| 2.4 | 签名落盘：写 `<UPD>\qomicex-update-<VER>.sig`（随包同目录） | |
| 2.5 | detect_strategy()：windows→`dir`+`--install-dir <壳exe父目录>`；macos→`app`+`--app-bundle`；linux→`$APPIMAGE`有→`appimage` / 无→`system` | |
| 2.6 | `--launch <current_exe>`（当前壳 exe 全路径） | |
| 2.7 | `--wait-pid <launcher pid>` + `--log <DATA>\log\qomicex-updater-<launcher pid>.log` | log 目录壳侧 create_dir_all |
| 2.8 | spawn updater（DETACHED_PROCESS\|CREATE_NEW_PROCESS_GROUP\|CREATE_NO_WINDOW），argv 逐项带引号写入 tauri log | **完整命令行**见下 |
| 2.9 | sleep 300ms → 总 flush → `app.exit(0)` → RunEvent::Exit：kill 内嵌 backend + wait | tauri log `stage6 exiting` |

**阶段 2.8 完整命令行**（argv 原样，Windows 实例）：
```text
<UPD>\qomicex-updater.exe
  --package    <UPD>\qomicex-update-<VER>.zip
  --signature  <UPD>\qomicex-update-<VER>.sig
  --strategy   dir
  --wait-pid   <launcher pid>
  --log        <DATA>\log\qomicex-updater-<launcher pid>.log
  --install-dir "C:\Users\<u>\AppData\Local\Qomicex Launcher"
  --launch     "C:\Users\<u>\AppData\Local\Qomicex Launcher\Qomicex Launcher.exe"
```

## 阶段 3：updater 执行（Qomicex.Updater，独立无 GUI 进程）

| 步 | 动作 | 失败退出码 |
|---|---|---|
| 3.0 | ulog 落盘：`--log` 优先，fallback sig 同目录；每节点（start/verify/wait/install/launch/done）+ rename 失败明细（含文件名） | — |
| 3.1 | minisign 校验 zip 全文（公钥 `35DD6AE53301ABE3` 内嵌；sig 兼容 base64 包裹/裸 armor） | 3 |
| 3.2 | wait_process_exit(--wait-pid)：tasklist 轮询 500ms，上限 180s（launcher 退出实测可慢） | 5 |
| 3.3 | dir 策略 install_dir：staging=`<INST>` 同卷父级 `.dir-update-tmp-Qomicex Launcher` → zip 解压到 staging（mangled_name 防穿越，unix 保留 mode）→ move_tree 逐项 remove+rename 到 `<INST>` → 清 staging | 2 |
| 3.4 | launch：先剥 `QOMICEX_LAUNCHER_MANAGED`/`QOMICEX_UPDATER_PATH` env → `Command::new(--launch 值)` + DETACHED\|NEW_GROUP | 2 |
| 3.5 | done，进程退出 | 0 |

**覆盖后的 `<INST>` 内容**（= zip 内容 = NSIS 安装布局）：`Qomicex Launcher.exe`（新壳，内嵌新 backend）+ `uninstall.exe` +（CI 收集目录里的 Packet.dll/wintun.dll 若有）。**不含独立 qomicex-backend.exe**（backend 嵌壳运行时释放）。

## 阶段 4：新壳启动

| 步 | 动作 |
|---|---|
| 4.1 | 新版壳（`<INST>\Qomicex Launcher.exe`）启动 → extract_backend：写 `<TMP>\qomicex-backend.exe` + Packet.dll + wintun.dll |
| 4.2 | spawn backend：env `QOMICEX_IPC_PIPE=\\.\pipe\qomicex-backend-<pid>` + `QOMICEX_NO_TCP=1`，CREATE_NO_WINDOW，stdout/stderr piped → `{BaseDir}/logs/qomicex-backend.log` |
| 4.3 | 前端 initApiTransport 探测 qomicex:// 管道成功 → 正常运行（关于页显示新版本号） |

## 退出码表（qomicex-updater）

`0` 成功 | `1` 用法错误 | `2` IO/启动失败 | `3` 签名无效 | `4` 策略失败（system/app） | `5` 等待超时

## 可观测性

- launcher 侧：tauri log `[updater] stage1-6 ...`（全步骤实际求值；`{BaseDir}/logs/qomicex-tauri.log`）
- updater 侧：`<DATA>\log\qomicex-updater-<pid>.log`（全节点，rename 失败含文件名）
- 下载：下载中心 SSE + `GET /api/plugins/download/{taskId}/progress`
- 诊断路径收敛：更新域（包/updater/sig 在 `<UPD>`）+ 双日志（tauri log 与 updater log）

## 已知事故史（回归防护）

1. sig 为 base64 包裹格式未兼容 → exit 3（27b40ed 修）
2. wait 30s 超时（launcher 退出实测慢）→ exit 5 → install/launch 全跳（e0b8901 修：180s）
3. MANAGED/UPDATER_PATH env 被新壳继承 → 新壳不自管 backend（e0b8901 修：launch 前剥离）
4. version 未校验直进文件名（安全）（faec8e8 修）
5. updater 释放落 %TEMP%（系统清理误删/诊断分散）→ 27b40ed+20a8da1 修：统一 `<UPD>` + `--log` 日志落位



### 2026-09-10 更新
# 自更新安装全流程规格（释放物/路径/参数全量）

> 对应 ADR-067。本文为运行时规格：每个环节跑了什么程序、完整参数、写了哪些文件到哪里。
> 路径占位：`<INST>`=安装根（Windows 默认 `%LOCALAPPDATA%\Qomicex Launcher`）；`<TMP>`=`%LOCALAPPDATA%\Temp\qomicex`；`<DATA>`=backend settings 的 dataDir（用户可改，如 `C:\qomicex-launcher`）；`<VER>`=目标版本号（如 `0.1.0-beta23.0`）；`<UPD>`=`<DATA>\updates`（更新域：包+updater+sig 同目录）。
> 日志域：壳/launcher 侧 → `{BaseDir}\logs\qomicex-tauri.log`；backend → `{BaseDir}\logs\qomicex-backend.log`；**updater → `<DATA>\log\qomicex-updater-<pid>.log`**（`<UPD>` 的 `../log/`，由壳以 `--log` 传入）。

## 阶段 0：检查更新

| 步 | 动作 | 位置/参数 |
|---|---|---|
| 0.1 | 前端 `fetchUpdatePlan(channel)` | App.tsx 启动 5s 后 / Settings 手动 |
| 0.2 | `GET /api/update/plan?channel=` | 本地 backend（`<TMP>\qomicex-backend.exe`，env `QOMICEX_IPC_PIPE=\\.\pipe\qomicex-backend-<pid>` `QOMICEX_NO_TCP=1`，CREATE_NO_WINDOW） |
| 0.3 | 转发 `https://api.qomicex.top/api/client/update/plan` | query: `current=<壳 APP_VERSION> target=<consts::OS> arch=<consts::ARCH> mode=<linux: $APPIMAGE 无→system> channel=<透传>` |
| 0.4 | upstream 灰度裁决（weight+machineHash）→ 200 plan / 204 | update-plan.ts；packageUrl 套 gh-proxy 竞速前缀（本地后端 L117） |
| 返回 | `{hasUpdate,version,strategy,packageUrl,signature,changelog,required}` | signature=minisign armor 的 base64 包裹（tauri signer 格式） |

## 阶段 1：下载（下载中心任务）

| 步 | 动作 | 位置/参数 |
|---|---|---|
| 1.1 | `POST /api/plugins/download/start` | body `{url: packageUrl, targetPath: "<UPD>/qomicex-update-<VER>.zip"}`（updaterStore.ts） |
| 1.2 | backend `DownloadManager.add(task)` 多线程下载 | 落盘 `<UPD>/qomicex-update-<VER>.zip`（暂存 `.qdtmp` 后缀，完成 rename） |
| 1.3 | session 进下载中心 SSE | session_json type=resource |
| 1.4 | 前端轮询 `GET /api/plugins/download/{taskId}/progress` | 1s 间隔；completed→阶段 2；failed/cancelled→error |

## 阶段 2：交接（Tauri 壳内，src-tauri/src/updater.rs）

壳侧每一步（stage1-6）以**实际求值**写入 tauri log（tag `[updater]`），每步写后 `flush_log()`（write+sync_all）；`app.exit(0)` 前再总 flush——detached updater 启动前的壳侧观测全程可见。

| 步 | 动作 | 位置/参数 |
|---|---|---|
| 2.1 | `invoke('run_updater', {packagePath, signature, version})` | updaterStore.ts；updatesDir 由 packagePath.parent() 推导 |
| 2.2 | extract_updater(updatesDir)：release 走 `include_bytes!("../binaries/updater.exe")` → **写 `<UPD>\qomicex-updater.exe`**；dev：`QOMICEX_UPDATER_PATH`/兄弟仓库构建产物**统一复制落位** `<UPD>` | unix chmod 755；dev 源不可复制时回退原路径 |
| 2.3 | version semver 校验（剥 `v`）→ 防路径穿越 | INVALID_VERSION 短路 |
| 2.4 | 签名落盘：写 `<UPD>\qomicex-update-<VER>.sig`（随包同目录） | |
| 2.5 | detect_strategy()：windows→`dir`+`--install-dir <壳exe父目录>`；macos→`app`+`--app-bundle`；linux→`$APPIMAGE`有→`appimage` / 无→`system` | |
| 2.6 | `--launch <current_exe>`（当前壳 exe 全路径） | |
| 2.7 | `--wait-pid <launcher pid>` + `--log <DATA>\log\qomicex-updater-<launcher pid>.log` | log 目录壳侧 create_dir_all |
| 2.8 | spawn updater（DETACHED_PROCESS\|CREATE_NEW_PROCESS_GROUP\|CREATE_NO_WINDOW），argv 逐项带引号写入 tauri log | **完整命令行**见下 |
| 2.9 | sleep 300ms → 总 flush → `app.exit(0)` → RunEvent::Exit：kill 内嵌 backend + wait | tauri log `stage6 exiting` |

**阶段 2.8 完整命令行**（argv 原样，Windows 实例）：
```text
<UPD>\qomicex-updater.exe
  --package    <UPD>\qomicex-update-<VER>.zip
  --signature  <UPD>\qomicex-update-<VER>.sig
  --strategy   dir
  --wait-pid   <launcher pid>
  --log        <DATA>\log\qomicex-updater-<launcher pid>.log
  --install-dir "C:\Users\<u>\AppData\Local\Qomicex Launcher"
  --launch     "C:\Users\<u>\AppData\Local\Qomicex Launcher\Qomicex Launcher.exe"
```

## 阶段 3：updater 执行（Qomicex.Updater，独立无 GUI 进程）

| 步 | 动作 | 失败退出码 |
|---|---|---|
| 3.0 | ulog 落盘：`--log` 优先，fallback sig 同目录；每节点（start/verify/wait/install/launch/done）+ rename 失败明细（含文件名） | — |
| 3.1 | minisign 校验 zip 全文（公钥 `35DD6AE53301ABE3` 内嵌；sig 兼容 base64 包裹/裸 armor） | 3 |
| 3.2 | **等待目标解锁**：`probe_unlockable(--launch 壳exe)`——launcher 退出 ⇔ exe 镜像锁释放，**锁定态强制 kill 启动器**：`taskkill /PID <wait-pid> /F`（CREATE_NO_WINDOW；**无 /T**——/T 树递归进共享 WebView2 池会连带杀掉 updater 自身）→ 30s 解锁兜底；未提供 --launch 时回退 pid wait（180s，仅兼容） | 5 |
| 3.3 | dir 策略 install_dir：staging=`<INST>` 同卷父级 `.dir-update-tmp-Qomicex Launcher` → zip 解压到 staging（mangled_name 防穿越，unix 保留 mode）→ move_tree 逐项 remove+rename 到 `<INST>` → 清 staging | 2 |
| 3.4 | launch：先剥 `QOMICEX_LAUNCHER_MANAGED`/`QOMICEX_UPDATER_PATH` env → `Command::new(--launch 值)` + DETACHED\|NEW_GROUP | 2 |
| 3.5 | done，进程退出 | 0 |

**覆盖后的 `<INST>` 内容**（= zip 内容 = NSIS 安装布局）：`Qomicex Launcher.exe`（新壳，内嵌新 backend）+ `uninstall.exe` +（CI 收集目录里的 Packet.dll/wintun.dll 若有）。**不含独立 qomicex-backend.exe**（backend 嵌壳运行时释放）。

## 阶段 4：新壳启动

| 步 | 动作 |
|---|---|
| 4.1 | 新版壳（`<INST>\Qomicex Launcher.exe`）启动 → extract_backend：写 `<TMP>\qomicex-backend.exe`（占用时回退 `<pid>-qomicex-backend.exe`）+ Packet.dll + wintun.dll |
| 4.2 | spawn backend：env `QOMICEX_IPC_PIPE=\\.\pipe\qomicex-backend-<pid>` + `QOMICEX_NO_TCP=1`，CREATE_NO_WINDOW，stdout/stderr piped → `{BaseDir}/logs/qomicex-backend.log` |
| 4.3 | 前端 initApiTransport 探测 qomicex:// 管道成功 → 正常运行（关于页显示新版本号） |

## 退出码表（qomicex-updater）

`0` 成功 | `1` 用法错误 | `2` IO/启动失败 | `3` 签名无效 | `4` 策略失败（system/app） | `5` 等待超时

## 可观测性

- launcher 侧：tauri log `[updater] stage1-6 ...`（全步骤实际求值；`{BaseDir}/logs/qomicex-tauri.log`）
- updater 侧：`<DATA>\log\qomicex-updater-<pid>.log`（全节点，rename 失败含文件名）
- 下载：下载中心 SSE + `GET /api/plugins/download/{taskId}/progress`
- 诊断路径收敛：更新域（包/updater/sig 在 `<UPD>`）+ 双日志（tauri log 与 updater log）

## 已知事故史（回归防护）

1. sig 为 base64 包裹格式未兼容 → exit 3（27b40ed 修）
2. wait 30s 超时（launcher 退出实测慢）→ exit 5 → install/launch 全跳（e0b8901 修：180s）
3. MANAGED/UPDATER_PATH env 被新壳继承 → 新壳不自管 backend（e0b8901 修：launch 前剥离）
4. version 未校验直进文件名（安全）（faec8e8 修）
5. updater 释放落 %TEMP%（系统清理误删/诊断分散）→ 27b40ed+20a8da1 修：统一 `<UPD>` + `--log` 日志落位
6. **tasklist 进程探测中文系统失效**（无任务行本地化「信息:」不含 "INFO:"）→ process_alive 恒真 → wait 永久超时/挂起（三轮实测失败根因）→ be5e1ef 修：改文件锁探测
7. **taskkill /T 树递归自杀**（/T 深入共享 WebView2 进程池，updater 在同池被连带强杀，ulog 止于 unlocked 且 $LASTEXITCODE 空）→ be5e1ef 修：去 /T 只杀本体



### 2026-09-21 更新（ADR-081：更新检测改为通道模型）

阶段 0 的"是否有更新"改为按**发布通道（train）**裁决。完整背景见
`1-决策记录/ADR-081-启动器更新检测改为通道模型.md`。

## 阶段 0：检查更新（通道裁决）

| 步 | 动作 | 位置/参数 |
|---|---|---|
| 0.1 | 前端 `resolveChannel(APP_INFO.version)` | `src/lib/updateChannel.ts`：localStorage 显式选择 > 已安装构建所属列车；dev/unknown → `undefined`（跳过检查） |
| 0.2 | `GET /api/update/plan?channel=` | 本地 backend |
| 0.3 | 通道解析 + dev 短路 | `services/update_channel.rs`：`effective_channel()`；推导为 dev/unknown 时直接返回 `hasUpdate=false` + `reason:"dev-build"`，**不打上游** |
| 0.4 | 转发上游 | query 追加 `channel=<归一化通道>`（`stable`→`release`）；header `Authorization: Bearer <license_core::machine_code()>`（恢复灰度门控 + 许可证通道钉住） |
| 0.5 | 上游裁决 | `isUpdateFor(current, latest, currentCreatedAt, latestCreatedAt)`：同列车 → `compareVersions`；跨列车 → 比 `versions.createdAt`；`current` 不在表中 → false |
| 0.6 | **本地不变量守卫** | `guard_train_plan()`：候选解析失败 / 候选列车 ≠ 请求通道 / 同列车且候选 ≤ 当前 → `hasUpdate=false` + `tracing::warn!` |

## `/plan` 响应新增字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `channel` | string | 候选版本所属列车（release / beta / alpha） |
| `channelSwitch` | bool | true = 跨通道（用户主动切换通道）。UI 必须标注为"切换通道"而非普通升级 |
| `reason` | string | `hasUpdate=false` 的原因：`dev-build` / `up-to-date` / `channel-mismatch` / `not-newer` / `no-version` |

## 通道语义表

| 已安装 | 请求通道 | 上游候选 | 结果 |
|---|---|---|---|
| `0.1.0-beta23.0` | beta（推导） | `0.1.0-beta31.0` | 有更新（同列车，31>23） |
| `0.1.0-release1.0` | beta（显式） | `0.1.0-beta31.0` | 有更新 + `channelSwitch=true`（发布时间 09/21 > 09/13） |
| `0.1.0-beta31.0` | stable（显式） | `0.1.0-release1.0` | **无更新**（跨通道且发布时间更早 = 降级，拒绝） |
| `0.1.0`（dev） | 无（推导失败） | — | 无更新 + `reason=dev-build`，不打上游 |
| `0.1.0-beta23.0` | beta | `0.1.0-release1.0`（上游配置回退） | 本地守卫拒掉 → `channel-mismatch` |

## 关联回归（三个症状的防护）

1. **beta 持续提示更新到正式版**：`getAllowedTypes('beta')` 曾含 `release`，叠加
   `TYPE_ORDER(release>beta)` 后 `latest` 恒为 release。已收窄为 `['beta']`，
   并由本地守卫二次校验候选列车。
2. **正式版无法更新到 beta**：同根因。`null`（旧版启动器未传）保持
   `['beta','release']` 不变以兼容存量客户端。
3. **开发版提示需更新到正式版**：`parseVersion` 的 `SIMPLE_RE` 把裸 `X.Y.Z` 归为
   `type:'release', suffix1:0`。现由 `trainOf` 判为 dev → 不推送。

## ✅ 部署状态（2026-09-21，已部署生效）

ADR-081 的 API 侧改动**已部署**（本地 `pnpm deploy:api`，绕开持续失败的
`deploy.yml`）：

| 提交 | 内容 |
|---|---|
| `f7ec0b5` | 通道模型主体：`trainOf` / `isUpdateFor`、`getAllowedTypes('beta')` 收窄、两路由改判据 |
| `78ddcaf` | 修正两个缺陷（见下） |

部署后线上实测矩阵（`/api/client/update/plan`，Version `c853c784`）：

| 已安装 | 请求通道 | 结果 |
|---|---|---|
| `0.1.0-beta23.0` | beta | 200 → **`0.1.0-beta31.0`**，`channelSwitch=false` |
| `0.1.0-release1.0` | beta | 200 → **`0.1.0-beta31.0`**，`channelSwitch=true` |
| `0.1.0-beta31.0` | stable | 204（拒绝降级） |
| `0.1.0`（dev） | beta | 204（开发构建不推送） |
| `0.1.0-alpha20260823.0` | alpha | 204（已是最新 alpha） |
| `0.1.0-release1.0` | release | 204（已是最新 release） |

`/api/client/version/check` 矩阵一致。

### 首轮部署后实测发现并已修的两个缺陷（回归防护）

1. **`currentRow` 在通道过滤后的列表里查找**：跨通道切换时 current 不在本通道
   候选列表 → 恒找不到 → `isUpdateFor` 缺 `createdAt` 恒 false →
   "正式版切到 beta" 永远 204（症状①复发）。修法：热路径先用 `allVersions`，
   miss 再补一次不带 type 过滤的精确查询。
2. **`/version/check` 从不读 query 的 `channel`**：历史上只从 `verifyLicense`
   取通道，不带 Bearer 的请求（绝大多数）恒走 `getAllowedTypes(null)`
   = `['beta','release']`，用户选的通道完全无效。修法：与 `/update/plan` 对齐。

> 另：`update-plan.ts` 首轮编辑曾吞掉 `client-license` 的 import 行——vitest
> 只测 `platformKey`/`strategyFor`、不触发路由故未暴露，是 `tsc --noEmit` 抓到的。
> **教训：改该仓库必须跑 `pnpm --filter api run typecheck`，单跑 test 不够。**

### 遗留

`deploy.yml` 的 `Cloudflare API Authentication failed (status: 400) [code: 9106]`
未修（GH secret `CLOUDFLARE_API_TOKEN` 仍无效）。本次为本地手动部署，
后续 master push 不会自动生效，需继续手动 `pnpm deploy:api` 或修 secret。


### 2026-10-05 更新

### 2026-10-05 更新（ADR-107：默认自动下载 + Toast 待安装）

> 需求：有更新时**默认自动下载**并弹可点击的 Toast；**不点击则下次打开
> 自动装完**；设置里可改回原有的弹出 Dialog。完整决策见
> `1-决策记录/ADR-107-启动器更新改为默认自动下载并弹Toast待安装-不点击下次启动自动装完-设置可回退弹窗.md`。

## 与原有链路的差别

原链路（上方数据流）在「下载完成」到「用户点立即更新」之间**没有任何持久化状态**：
`updaterStore` 只把进度放在内存里，进程一关就必须重下几十 MB，无法实现「下次打开自动
装完」。ADR-107 在壳侧补一份**待安装记录**，把这一刻变成可跨进程的持久事实。

```
App.tsx 启动 5s 后台检查 → plan（普通更新且开关开）
  → updaterStore.autoStart(plan)              （不主动重启）
      → POST /api/plugins/download/start      （同上，落 <DATA>/updates/*.zip）
      → 轮询到 completed
      → invoke('stage_pending_update_install') → 写 update-auto-install.json
      → phase='ready' → UpdateReadyToast（底部居中横幅，点击=立即重启安装）
  → 用户不点，关掉启动器
下次启动（无实例在跑）
  → invoke('take_pending_update_install')     → ready（attempts 已 +1 并落盘）
  → 复用同一条 run_updater 链路 → 覆盖安装 → 新版本启动
  → invoke('take_pending_update_install')     → installed（版本已一致）→ 清记录，不再重复装
```

## 待安装记录（壳侧持久化）

`{dataDir}/updates/update-auto-install.json`，与 `.zip`/`.sig` 同目录（dataDir 改了记录
跟着走，不会出现「记录在 localStorage 而包在旧 dataDir」的错配）：

```json
{
  "pending": { "version": "0.1.0-beta32.0", "packagePath": "<DATA>/updates/qomicex-update-….zip",
               "signature": "<minisign armor>", "changelog": "…", "attempts": 1, "channel": "beta" },
  "abandonedVersion": "0.1.0-beta31.0"
}
```

写入一律「先写 `.tmp` 再 rename」原子覆盖（与 `pending-update-notice.json` 同语义）；
内容为空时删除文件，不在 `updates/` 留残渣。

> 与 `pending-update-notice.json` 的区别：那个是更新**完成后**的交接（给新进程弹「更新
> 完成」），这个是更新**开始前**的交接（给新进程自动装完）。方向相反、文件名不同。

## Tauri 命令（4 个）

| 命令 | 作用 |
|---|---|
| `update_auto_install_state(dataDir)` | 只读 peek：`hasPending` / `abandonedVersion` / `pending`。**不推进 attempts** |
| `stage_pending_update_install(dataDir, packagePath, signature, version, changelog?)` | 下载完成后落记录；拒绝空版本/空签名/包不存在 |
| `take_pending_update_install(dataDir)` | 消费记录（读后按结果写回），返回状态机结果 |
| `clear_pending_update_install(dataDir)` | 清记录与抑制标记（用户稍后 / 手动安装后 / 开关关闭） |

`take` 的状态机：

| 状态 | 条件 | 动作 |
|---|---|---|
| `installed` | 目标版本 == 当前运行版本（**已装成**），或目标版本**旧于**当前版本 | 清记录；前端不安装（收敛点 + 防静默降级） |
| `missing` | 包文件已不在（临时目录被清理/手删） | 作废记录可重下；**不**计入抑制（可恢复） |
| `abandoned` | `attempts >= 3` | 记 `abandonedVersion` 并清 pending；该版本不再自动装、回退弹窗 |
| `ready` | 其它 | 先递增 `attempts` **落盘**，再交给调用方 spawn updater |
| `none` | 无记录 | 无事可做 |

> `attempts` 必须在 spawn **之前**落盘：顺序颠倒会让「spawn 后进程崩溃」不计入重试，
> 重试上限形同虚设。

## 自动模式的触发条件

`App.tsx` 的 `resolveAutoInstallPlan()`，**全部**满足才走自动路径：

- 后台检查发现更新（`plan.hasUpdate && plan.version`）
- `updateAutoInstall !== false`（设置项，默认开）
- `!required`（强制更新保留「必须更新才能继续使用」语义，不静默）
- `!channelSwitch`（跨通道切换需用户知晓，见 ADR-081）
- 该版本未被 `abandonedVersion` 抑制
- 当前没有已 staged 的记录（不重复下载）
- `dataDir` 非空

任一查询失败 → 回退弹窗（宁可走原行为，也不要出现「既没弹窗也没提示」的黑洞）。

`required` / `channelSwitch` / 开关关闭 / 已作废 → 走**原有** `UpdateDialog` 路径，
原行为的 snooze（24h）与设置页常驻提示（ADR-095）不变。

## 启动自动安装

`backendState==='ready' && settingsReady` 后 2s（`autoInstallChecked` 只判一次）：

- **有实例在跑** → 推迟到下次启动，并把磁盘记录 `restoreStaged` 成可点击的 Toast
  （否则已下好的包在本会话完全不可见）。推迟是必需的：安装会 `app.exit(0)` 重启启动器，
  会把用户正在玩的游戏连启动器一起关掉。
- 无实例 → `installStagedOnLaunch()` 直接装完。

## 防静默降级

`is_older_than(staged, current)`：用户手动点过「立即更新」装上更新版本后，磁盘上可能残留
上一轮自动下载的**旧**包记录；照常安装就是一次静默降级。semver 比较，**解析失败时返回
false 保守放行**（不因解析不了就吞掉用户已下好的更新）。

前端 `store.start()` 同样收敛：待安装记录与本次手动目标**同版本** → 直接装（不重复下载）；
**不同版本** → 先清旧记录再走手动路径（否则旧记录会在下次启动把用户降级回去）。

## 设置项

`updateAutoInstall: Option<bool>`（`SettingsResponse`，`None`/`true` = 开启）。
UI：「设置 → 关于 → 更新」区新增一行 `Switch`。**关闭时同时清掉已 staged 的记录**，
否则那份记录会在下次启动被静默装完，用户会以为开关没生效。

## 本地验证

- `cargo test --manifest-path src-tauri/Cargo.toml --lib updater`（22 例，其中新增 12 例：
  生命周期端到端 / 防降级 / peek 不消费 attempts / 重试上限与作废 / 包缺失不作废 /
  损坏记录 / 空 dataDir / 重新 stage 清抑制）
- `pnpm run typecheck` + `pnpm run build`
- 全链路（下载→覆盖→重启）仍需 release 构建或双机实测


### 2026-10-05 更新

## 评审修正（PR #193 review，2026-10-05）

> 决策与教训详见 `1-决策记录/ADR-107-启动器更新改为默认自动下载并弹Toast待安装-不点击下次启动自动装完-设置可回退弹窗.md`
> 的「评审修正」一节。此处只记运行时行为变化。

### 记录格式新增 `channel`

```json
{
  "pending": { "version": "…", "packagePath": "…", "signature": "…",
               "changelog": "…", "attempts": 1, "channel": "beta" },
  "abandonedVersion": "…"
}
```

`channel` = 落盘时 update plan 的通道。**跨列车不得自动安装**（ADR-081）：用户可能在
下载完成后又切了通道，此时这份包已不属于当前列车，无人值守装上它就是一次静默的
跨列车更新。缺少该字段的旧记录视为「无法判定」**不拦**（否则老记录永远装不上）。

判定函数 `lib/updateChannel.ts::stagedChannelMatchesCurrent()` 由**自动安装**与
**恢复 Toast** 两条路径共用，保证结论一致——否则会出现「启动时不装，却给了个点了
就装的入口」这种自相矛盾。

### `take` 状态机新增 `unpersisted`

| 状态 | 条件 | 动作 |
|---|---|---|
| `unpersisted` | 尝试计数**写不进盘**（`.tmp` 写入失败等） | 拒绝本次无人值守安装，回退弹窗（保留手动入口） |

为什么必须拒装：计数存不下去时重试上限不再是可靠的失败遏制边界——每次启动都读到那个
没被递增过的旧计数，一个始终失败的包会被无限次自动重装、永远到不了「作废 + 回退弹窗」。
**手动路径（点 Toast → `installStaged`）不经过这条**，不受影响。

### 设置开关关闭 = 磁盘 + store 一起清

仅删磁盘记录不够：Toast 渲染自 store 的 `staged`，磁盘清掉后 Toast 仍在屏幕上且仍能
点击安装。关闭时调用 `updaterStore.discardStaged()`（清 `staged`/`phase`、停轮询）
**并** `clear_pending_update_install`。

### `autoStart` 在暂存边界复检开关

下载可能耗时几十秒，用户可能在期间关掉自动更新。下载完成后、写记录**之前**复检
`updateAutoInstall === false`；若已关闭则清掉刚下的记录、回 idle，不进入 `ready`。

### `fetchAutoInstallState` 的错误语义

IPC 失败**抛出**，由调用方 `resolveAutoInstallPlan` 的 catch 回退到更新对话框。
吞成「无待安装记录」会让它以为可以安全走自动下载（随后 autoStart 静默失败），
结果是既没对话框也没 Toast。只有空 `dataDir` 按无记录处理。

### 本地验证（更新）

- `cargo test --manifest-path src-tauri/Cargo.toml --lib updater` → **25 例**（新增
  通道往返/旧记录兼容/写失败拒装 3 例）
- `pnpm run typecheck`（含 i18n submodule）、`cargo fmt --check` 双 crate 通过



### 2026-10-06 更新

## 评审修正（第二轮，2026-10-05）

> 决策与实测证据见 ADR-107 的「评审修正（第二轮）」。

### 版本比较：必须数值感知，不能用 semver 的 Ord

`is_older_than` / `is_train_upgrade` 从 semver 改为**与后端同语义的数值解析**
（`parse_train_version` / `first_number_run`）。实测 semver 1.x：

```
parse("0.1.0-beta9.0") < parse("0.1.0-beta10.0")  ==  false   // beta9 被判成"更新"
```

原因：semver 对 pre-release 标识符按 ASCII 字典序比较，只有"纯数字标识符"才比数值；
而 `beta10` 整体是一个标识符，`'9' > '1'`。若不改，`take` 会把"待安装 beta10、
当前 beta9"误判为记录更旧 → 返回 `installed` 清记录 → **自动安装被静默跳过**。

| 输入 | semver Ord | 本实现（数值感知） |
|---|---|---|
| `beta9` vs `beta10` | beta9 更新（**错**） | beta9 更旧（对） |
| `beta9` vs `beta32` | beta9 更新（**错**） | beta9 更旧（对） |
| `beta31` vs `release1` | 可比（**错**） | 跨列车不可比 → false |
| `alpha…22.9` vs `…22.10` | 字典序（**错**） | 数值（对） |

跨列车返回 false（各列车序数独立计数，无法裁决 → 保守放行，不误判降级）。

### `takePendingInstall` 错误语义

IPC 失败**抛出**，不再返回 `none`：返回 `none` 会让 `installStagedOnLaunch` 当作
"没有待安装记录"直接返回 → 更新永久卡住且用户毫无提示。调用方 catch 后保留
`available`，由后台检查弹更新对话框。只有空 `dataDir` 返回 `none`。

### 自动更新开关：经父级 `update()` 写入

`AboutTab` 不再自持开关状态，改由父级下发值 + 回调，走 `update('updateAutoInstall', …)`。
原因：父级 `update()` 以 `{ ...settings, [key]: value }` 整体重建，而父级不订阅
`onSettingsChange`；若开关绕过父级直接 `saveSettings`，父级快照仍是旧值，用户之后改
任何其他设置都会把该项覆盖回 `true`。

### 下载终止：generation 代号

模块级 `downloadGeneration`；每个下载开始时捕获，**每次 await 之后**比对。
`stopPolling()`（含 `invalidateDownloads()`）被 `discardStaged` / `reset` 调用后，
在飞轮询以 `DOWNLOAD_ABORTED` reject、不写状态、不重排 timer。

为什么仅 `clearTimeout` 不够：它只能清掉尚未触发的 setTimeout。若正卡在
`await get(…progress)`，返回后仍会重排 timer 并把 phase 写回 `downloading`
（UI 被从 idle 拽回"下载中"），且 `downloadToUpdates` 的 Promise 永不 settle、
`autoStart` 一直挂着。调用方对该错误码静默收尾，不显示成"下载失败"。

### 本地验证（本轮）

- `cargo test --lib updater` → **28 例**；tauri 44、backend 419
- `pnpm run typecheck`（含 i18n submodule）、`pnpm run build`、`cargo fmt --check` 通过

