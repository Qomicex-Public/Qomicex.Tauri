# ADR-117：CurseForge 分发受限文件按阻塞清单处理，不绕过作者开关（issue #291）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-22 |
| 决策者 | AI Agent |

## 背景

issue #291：从资源中心安装 NAST 2.2（CurseForge 整合包，neoforge 1.21.1）后游戏能启动，但 KubeJS 的 10 个 startup_scripts 全部报 `ReferenceError: "MMCREvents" is not defined`。

实测证据：下载 NAST 2.2 本体（fileID 9277460）并读取包内 manifest.json，共 251 个文件、全部 required、0 个可选；其中含 `{"projectID":1654570,"fileID":9274793,"required":true}`，即 [MMCR] 模块化机械：社区版重制。用户日志的 264 个 mod 文件里没有任何 mmcr-*.jar，mod id 列表 265 项也无 mmcr；落盘 mods/ 242 个 jar 对 251 项清单，缺约 9 个。MMCREvents 正是 MMCR 提供的 KubeJS 绑定，缺失即可解释全部报错。

根因在 `src-backend/qomicex-backend/src/endpoints/modpack.rs` 的 CF 分支：批量接口返回的条目若 `downloadUrl` 为空，原实现 `missing += 1; continue;` 直接跳过。而唯一提示是一条 `tracing::warn!`，它经 `TraceWriter` 写入 trace 缓冲——该 writer 自己的注释写明「只进缓冲（不回显终端）」，因此不会出现在用户可见的日志里。`InstallProgress` 也没有任何字段承载这个信息（`failed_files` 全代码库恒为 0，只在构造时赋值）。

CurseForge 的 `downloadUrl: null` 是作者关闭 Project Distribution Toggle 的结果，不是接口故障：换 API Key、拼 CDN 直链、特殊 Token 均无效，且违反第三方 API 条款。`modpack_update.rs` 的原地更新分支有同源问题，连 warn 都没有。

## 决策

把 `downloadUrl` 为空识别为语义明确的业务状态（分发受限），不做任何绕过。

1. 判定逻辑抽成纯函数 `modpack_blocked::blocked_from_batch`，同时处理 `null` 与空串（CF 两种形态都出现过，只判 `is_none()` 会漏一半）。首次安装与原地更新共用，消除两处重复。
2. 阻塞条目落盘到 `{gameDir}/versions/{instanceName}/.qomicex/blocked-mods.json`，与 `modpack-manifest.json` 同目录：实例改名走整目录 rename，清单一并搬走。空清单删除文件而非留 `items: []`，避免 UI 误报。
3. `InstallProgress` 新增 `blockedFiles` 字段，与 `failedFiles` 分开——它不是下载失败，而是已知且可操作的阻塞，安装仍可完成。
4. 新增 `GET /modpack/blocked/{instanceId}` 与 `POST /modpack/blocked/{instanceId}/submit/{fileId}`。提交传本机绝对路径而非 multipart 上传：文件本就在用户机器上，读进内存再重传一遍纯属浪费（重型 mod 可达数百 MB），与既有 `/modpack/parse-path` 同一思路。
5. 补全用清单条目的 SHA-1 校验，不匹配则拒绝且不落盘、不清清单；源文件不删除、不移动（是用户自己的下载，可能还有别的实例要用）。
6. 项目页链接用 `https://www.curseforge.com/projects/{projectId}`：实测该形式 302 到 slug 页（HTTP 200），而 `projects/{id}/files/{fileId}` 是 404。
7. 原地更新额外做「已有同名文件则不算阻塞」的过滤：更新只差这一版文件时用户手头那个照样能跑，报出来只会让人以为实例坏了。

## 备选方案

### 方案 静默跳过但补一条可见日志
- 优点：改动最小，几行
- 缺点：用户仍然要自己从 KubeJS 报错倒推缺了什么；日志不会被主动看
- 为何不选：不采纳：没有解决「安装报成功但产物不可用」的核心问题

### 方案 必需文件缺失直接让整个安装失败
- 优点：不再产出损坏实例
- 缺点：用户只知道装失败了，不知道缺哪几个、去哪里补；且分发受限是常态而非异常
- 为何不选：不采纳：信息量不足，把可操作的阻塞降级成不可操作的失败

### 方案 换 API Key / 拼 CDN 直链绕过
- 优点：能自动补齐
- 缺点：违反 CurseForge 第三方 API 条款；限制在作者项目设置层，与调用方 Key 无关，实际也拿不到
- 为何不选：明确不采纳：合规红线

### 方案 支持拖拽文件到对话框补全
- 优点：交互更顺手，对齐 PrismLauncher 的 BlockedModsDialog
- 缺点：需要额外的全局拖拽事件接线与 Tauri 文件拖放通道；当前已用文件选择器覆盖同一需求
- 为何不选：暂不采纳：作为后续增强，本次先保证链路正确

## 影响
- src-backend/qomicex-backend/src/services/modpack_blocked.rs（新增，含 11 个单测）
- src-backend/qomicex-backend/src/endpoints/modpack.rs（CF 分支分流 + 两个新端点）
- src-backend/qomicex-backend/src/endpoints/modpack_update.rs（同源路径）
- src-backend/qomicex-backend/src/services/install_tracker.rs（blockedFiles 字段）
- src/api/modpack-blocked.ts、src/components/BlockedModsDialog.tsx（新增）
- src/pages/InstanceDetail.tsx（概况页提示横幅 + 对话框挂载）
- src/types/index.ts（BlockedModFile / BlockedModList）
- qomicex-tauri-i18n（7 种语言的 dialogs.blockedMods）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-22 | v1.0 | 初版创建 | AI Agent |