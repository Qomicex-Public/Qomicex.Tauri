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
