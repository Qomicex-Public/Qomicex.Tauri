# ADR-118：CurseForge 分发受限文件按阻塞清单处理，不绕过作者开关（issue #291）

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
3. `InstallProgress` 新增 `blockedFiles` 字段，与 `failedFiles` 分开——它不是下载失败，而是已知且可操作的阻塞。安装产物落盘后，只要有阻塞条目，任务状态就停在**非终态** `awaiting-files`，而不是 `completed`：下载中心据此显示「待补全」并保留入口，补全全部通过后才转 `completed`。等待期间更新/修复返回 `MISSING_MODS_PENDING`，不覆盖 tracker 槽位。
4. 新增 `GET /modpack/blocked/{instanceId}`、`POST /modpack/blocked/{instanceId}/submit`（按 SHA-1 匹配，供拖入多文件）、`POST /modpack/blocked/{instanceId}/submit/{fileId}`（逐条指定）与 `DELETE /modpack/blocked/{instanceId}`（放弃补全）。提交传本机绝对路径而非 multipart 上传：文件本就在用户机器上，读进内存再重传一遍纯属浪费（重型 mod 可达数百 MB），与既有 `/modpack/parse-path` 同一思路。
5. 补全用清单条目的 SHA-1 校验，不匹配则拒绝且不落盘、不清清单；源文件不删除、不移动（是用户自己的下载，可能还有别的实例要用）。`GET` 额外核对 `mods/` 目录：用户直接把 jar 放进目录也算补上（有哈希的必须一致），清单清空时结束等待态。
6. 项目页链接用 `https://www.curseforge.com/projects/{projectId}`：实测该形式 302 到 slug 页（HTTP 200），而 `projects/{id}/files/{fileId}` 是 404。补全入口的「对应版本」直达链接见 ADR-123（issue #301）：由 `links.websiteUrl` 拼 `/files/{fileId}`，只在响应里补全、不写回清单。
7. 原地更新额外做「已有同名文件则不算阻塞」的过滤：更新只差这一版文件时用户手头那个照样能跑，报出来只会让人以为实例坏了。
8. 补全入口放在下载中心的等待任务上：对话框支持把 jar 拖进来（可多选，后端按哈希匹配），也保留逐条「选择文件」。

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

### 方案 补全入口只放在实例详情页横幅
- 优点：实现最省事，不碰下载中心
- 缺点：任务在下载中心显示为「已完成」，用户不会再去看它；详情页横幅是第二套入口，两处状态容易漂移
- 为何不选：不采纳：等待补全本质是未完成任务，应留在下载中心，补全后才算完成

## 影响
- src-backend/qomicex-backend/src/services/modpack_blocked.rs（新增，含 13 个单测）
- src-backend/qomicex-backend/src/endpoints/modpack.rs（CF 分支分流 + 四个新端点）
- src-backend/qomicex-backend/src/endpoints/modpack_update.rs（同源路径 + 等待态守卫）
- src-backend/qomicex-backend/src/endpoints/instance.rs（等待态期间拒绝修复）
- src-backend/qomicex-backend/src/services/install_tracker.rs（blockedFiles 字段 + awaiting-files 状态）
- src/api/modpack-blocked.ts、src/components/BlockedModsDialog.tsx（新增）
- src/pages/DownloadCenter.tsx（待补全状态、筛选、补全按钮与对话框挂载）
- src/hooks/useDownloadSSE.ts、src/types/index.ts（blockedFiles / 等待态）
- qomicex-tauri-i18n（7 种语言的 downloads.awaiting-files、dialogs.blockedMods）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-22 | v1.0 | 初版创建 | AI Agent |
| 2026-10-23 | v1.1 | 补全入口由实例详情页改为下载中心等待态，补全前不再标完成；新增拖入多文件、重扫与放弃补全 | AI Agent |