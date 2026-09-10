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

