# ADR-110：保持 tauri identifier 为模板值 com.tauri-app.qomicex-launcher（issue #238）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-10 |
| 决策者 | AI Agent |

## 背景

issue #238 指出 `src-tauri/tauri.conf.json` 的 `identifier` 仍是 Tauri 模板默认值 `com.tauri-app.qomicex-launcher`。该字段决定应用的数据目录身份，修改它等于让现有用户的配置目录「搬家」（实例列表、账号、设置、插件全部看似丢失）。因此需要一次**有意识的决策**：保持，或迁移并记录方案。

## 决策

本轮**保持不变**，维持 `com.tauri-app.qomicex-launcher`。理由：当前处于 beta 阶段但已有实际用户数据，改动 identifier 而不配套迁移会让老用户配置失效；而数据目录迁移（复制 + 校验 + 失败回滚）是一个独立特性，不应捆绑在 #238 的配置漂移修复中。本轮只做无用户可见后果的三项（权限表收敛、Tailwind preset 合并、theme 双写收敛、npm→pnpm），identifier 单独登记为待决策项。未来若要迁移，需同时实现：旧 identifier 目录探测 → 复制到新目录 → 校验完整性 → 失败回滚，并在发布说明中提示。

## 备选方案

### 方案 迁移为 com.qomicex.launcher
- 优点：语义正确、与产品名一致
- 缺点：老用户配置「搬家」：数据目录身份由 identifier 决定，改动会让现有用户的实例/账号/设置看起来全部丢失
- 为何不选：需要配套一次性数据目录迁移与回滚方案，成本与风险超出本轮 issue 修复范围；且当前仍在 beta（v0.1.2-beta4），迁移窗口虽在但需独立评审

### 方案 立即改并同时实现迁移
- 优点：一次性到位
- 缺点：发布到应用商店/系统集成时 identifier 不规范，后续改动晚一天成本都更高
- 为何不选：迁移逻辑（复制旧目录、成功校验、失败回滚）本身是一个独立特性，应单独立项而不是捆绑在 #238 的配置漂移修复里

## 影响
- src-tauri/tauri.conf.json（本轮仅改 beforeDevCommand/beforeBuildCommand 为 pnpm，identifier 未动）
- docs/TODO.md（登记为待决策项）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-10 | v1.0 | 初版创建 | AI Agent |