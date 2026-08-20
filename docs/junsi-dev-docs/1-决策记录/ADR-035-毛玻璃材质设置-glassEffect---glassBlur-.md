# ADR-035：毛玻璃材质设置（glassEffect + glassBlur）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-21 |
| 决策者 | AI Agent |

## 背景

用户要求新增毛玻璃材质效果：启用后所有卡片、dialog、对话框启用 blur 毛玻璃，并支持强度调节。选定方案 B（改 plugin-ui 组件打 glass-surface 标记类）+ 开关 + 强度滑块。plugin-ui 为纯 tsc 构建、无 CSS 文件。

## 决策

后端新增 glass_effect(Option<bool>) 与 glass_blur(Option<i32>) 字段（serde default），前端 AppSettings 默认 false/18。plugin-ui 的 Card 根、Dialog 表面、MessageBox toast 元素显式加 glass-surface 标记类。应用 src/index.css 定义 :root[data-glass=\"true\"] .glass-surface { background-color: hsl(var(--card)/0.6); backdrop-filter: blur(var(--glass-blur,18px)) saturate(150%) }。App.tsx 在设置加载/变更时设 documentElement.dataset.glass 与 --glass-blur。设置页外观新增「毛玻璃材质」开关 + 强度滑块(2-40px)。重建 plugin-ui dist。

## 备选方案

### 方案 方案 A：全局 CSS 按 utility 类名覆盖（bg-card/bg-popover）
- 优点：不重建 plugin-ui
- 缺点：靠类名覆盖、侵入面不够显式；用户选择 B
- 为何不选：未说明

### 方案 仅 on/off 无强度
- 优点：更简
- 缺点：用户要求可调强度
- 为何不选：未说明

## 影响
- packages/plugin-ui/src/components/{Card,Dialog,MessageBox}.tsx（glass-surface）
- src/index.css（玻璃规则）
- src/App.tsx（data-glass/--glass-blur）
- src/api/settings.ts
- src/pages/Settings.tsx
- src-backend/.../settings.rs
- qomicex-tauri-i18n（7 语言）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-21 | v1.0 | 初版创建 | AI Agent |