# ADR-088：模组删除一致性与错误上报：失效后重载 + 请求序号保护 + 后端 IO 错误传播

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-01 |
| 决策者 | AI Agent |

## 背景

Issue #140：右键删除单个模组「无效」或删除后列表仍残留该行；左键多选批量删除正常。根因有三层：（1）`ModCard.handleDelete` 删除后调用 `onRefresh`（即 `loadMods`），但未使 `api-instance-${instanceId}-mods` 的 30s TTL 前端缓存失效，`loadMods` 直接命中旧缓存把已删除的行原样读回——批量删除路径在 `handleBatchAction` 里先 `cacheInvalidate` 再 `loadMods`，所以正常；（2）`loadMods` 无请求序号保护，较晚返回的旧响应（含切换实例后的旧实例响应）会覆盖已删除的新状态；（3）后端 `delete_mod_file` 用 `let _ =` 丢弃 `remove_file` 错误、文件不存在也静默返回，`delete_mod` 恒返回 204，因此 Windows 下文件被游戏进程占用时前端收到「成功」，用户无任何提示。另：禁用文件命名回退用 `set_extension("disabled")`（`foo.jar` → `foo.disabled`），与前端 `fileName + '.disabled'` 约定不一致。上游 origin/main（截至 #137）未包含该修复，故自研。

## 决策

1) 前端刷新统一：ModsTab 新增 `refreshMods = useCallback(async () => { cacheInvalidate(key); await loadMods() })`，单卡片删除与批量操作共用同一条「失效后重载」路径，缓存键收敛在 ModsTab 内。2) `useRef` 请求序号保护：`loadMods` 入口 `++seq`，`getModsMetadata` 返回后、`applyEnrich` 合并与 `cacheSet` 前、`catch`/`finally` 中均校验序号，过期请求不写 `setMods`/`cacheSet`/`setLoading`/`setEnriching`；不引入 AbortController。3) 后端 `delete_mod_file` 返回 `std::io::Result<()>`，依次尝试原路径 → 追加 `.disabled` → `set_extension("disabled")` 历史回退，全不存在返回 `NotFound`，`remove_file` 错误用 `?` 传播；`delete_mod` 用 `.map_err(ApiError::from)?` 传播（复用既有 io 映射：NotFound→404 / PermissionDenied→403 / 其他→500），成功仍 204。`batch_delete_mods`/`batch_update_mods` 仅 `tracing::warn!` 记录失败并继续，HTTP 契约保持 200 不变。4) `ModCard.handleDelete` 成功/失败均 `notify`，`finally` 中 `try { await onRefresh() } finally { setDeleting(false) }`，即使后端 404（文件已不存在）也清掉残留行；`onRefresh` prop 类型放宽为 `() => void | Promise<void>`。5) i18n 复用已存在的 `dialogs.common.deleted`/`dialogs.common.deleteFailed`（7 个 locale 均有），不新增键、不改 submodule。

## 备选方案

### 方案 在 ModCard 内自行 cacheInvalidate 后调用 onRefresh
- 优点：改动局限在单个组件
- 缺点：缓存键与失效知识泄漏到叶子组件；ModCard 其他依赖 onRefresh 的操作（启用/禁用、卡片内更新）仍读过期缓存
- 为何不选：舍弃——缓存键应集中在持有它的 ModsTab 内

### 方案 删除后本地乐观 setMods 过滤掉该行
- 优点：零额外请求，UI 立即反馈
- 缺点：绕过文件系统的权威状态；删除失败时会错误地隐藏仍存在的文件，且缓存未更新，下次重载行又回来
- 为何不选：舍弃——本 issue 要求「列表反映文件系统状态」

### 方案 引入 AbortController 取消过期请求
- 优点：从传输层根治竞态
- 缺点：需贯穿 api 层传递 signal，改动面大；与本 issue 范围不符
- 为何不选：舍弃——issue 明确要求不引入 AbortController 或新抽象

### 方案 后端单删与批量删除均改为严格失败并返回逐项结果
- 优点：语义最严格
- 缺点：改变 batch 接口的返回契约，影响既有调用方
- 为何不选：舍弃——issue 明确要求保持批量删除 HTTP 契约不变

## 影响
- src/pages/InstanceDetail.tsx — ModsTab：新增 loadModsSeqRef / refreshMods，loadMods 加序号保护与轮询清理修复，handleBatchAction 改用 refreshMods，ModCard 传 onRefresh={refreshMods}
- src/components/ModCard.tsx — onRefresh 类型放宽，handleDelete 加成功/失败通知并 await 刷新
- src-backend/qomicex-backend/src/endpoints/instance_files.rs — delete_mod_file 返回 io::Result 并补 .disabled 追回退；delete_mod 传播错误；batch_delete_mods / batch_update_mods 记 warn；新增 4 个 #[cfg(test)] 用例
- API 行为变更：DELETE /api/instance/{id}/files/mods 由「恒 204」改为可返回 404（文件不存在）/ 403（被占用或无权限）/ 500；batch-delete 与 batch-update 契约不变
- 已知低风险边界：src/lib/updateMods.ts 在下载完成后调用 deleteMod 删旧文件，若旧文件已不存在，该更新项由「计入成功」变为「计入失败」（旧行为依赖 deleteMod 静默成功）
- 未改动：ContextMenu.tsx、选择逻辑、隐藏选中项策略、useListSelection 迁移、mods 更新缓存、路径穿越校验、i18n submodule

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-01 | v1.0 | 初版创建 | AI Agent |