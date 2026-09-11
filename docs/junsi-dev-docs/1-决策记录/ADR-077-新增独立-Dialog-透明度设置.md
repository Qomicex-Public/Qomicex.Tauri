# ADR-077：新增独立 Dialog 透明度设置

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-11 |
| 决策者 | AI Agent |

## 背景

Dialog 透明度无法调整。根因：dialogOpacity 从未实现（此前确认后未落地）。dialog 背景由 index.css 的 .glass-surface 材质规则间接决定（default 跟随 cardOpacity、frosted 0.6、acrylic/aero 0.2、liquid 0.42），且卡片透明度滑块仅在 default 材质下显示（Settings.tsx），其他材质下无任何可调项。

## 决策

新增独立 dialogOpacity 设置（默认 75，0-100）：后端 settings.rs 加 dialog_opacity 字段（serde 自动兼容旧配置）；前端 App.applyDialogOpacity / Settings.saveSettings 写 --dialog-opacity 变量；Dialog.tsx 内容层加 inline style backgroundColor: hsl(var(--popover)/var(--dialog-opacity,0.75)) 覆盖材质规则；滑块放在组件材质 SettingSection 内、对所有材质显示（不受 default 限制）；i18n 7 语言补 dialogOpacity/dialogOpacityDesc。

## 备选方案

### 方案 复用 cardOpacity
- 优点：改动最小
- 缺点：用户明确要独立设置；与卡片透明度语义不同（卡片仅 default 材质生效）
- 为何不选：舍弃

### 方案 在 CSS 里加各材质的 dialog 透明度分支
- 优点：无需 inline style
- 缺点：需为 5 种材质各写一条覆盖规则，且无法真正独立于材质
- 为何不选：舍弃

### 方案 独立 dialogOpacity 设置 + inline CSS 变量
- 优点：对所有材质通用、独立于材质；inline 优先级高于非分层 .glass-surface
- 缺点：无
- 为何不选：采纳

## 影响
- src-backend/qomicex-backend/src/settings.rs
- src/api/settings.ts
- src/App.tsx
- src/pages/Settings.tsx
- packages/plugin-ui/src/components/Dialog.tsx
- qomicex-tauri-i18n/src/{zh-CN,zh-TW,zh-HK,en-US,en-GB,ja-JP,ru-RU}/settings.ts

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-11 | v1.0 | 初版创建 | AI Agent |