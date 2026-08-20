# ADR-033：个性化设置支持自定义主题色（Accent Color）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-21 |
| 决策者 | AI Agent |

## 背景

现有个性化设置仅支持 dark/light 主题切换，主题强调色（实现为 index.css 的 --primary/--ring/--primary-foreground HSL 变量）固定为绿色。用户要求"优化个性化设置，支持设置主题色"，方向确认为预设色板 + hex 取色器，且只影响全局主色（按钮/高亮/焦点环/选中态）。

## 决策

AppSettings 新增可选字段 themeColor（hex 字符串，空=默认绿）。新增 src/lib/themeColor.ts：把 hex 转 HSL 后覆盖 documentElement 的 --primary/--ring，并按 WCAG 相对亮度自动选择 --primary-foreground 黑/白确保对比度；传空则移除覆盖恢复 CSS 默认。深浅主题共用同一强调色。App.tsx 在 settings 加载与 onSettingsChange 变更时应用。后端 SettingsResponse 新增 #[serde(default)] theme_color 字段持久化。外观页新增预设色板(绿/蓝/紫/橙/红/青/粉/琥珀) + 原生 <input type=color> 取色器 + 恢复默认。i18n 全部 7 语言补充键位。

## 备选方案

### 方案 仅色相滑块（hue-only）
- 优点：保留深浅主题的饱和/明度与前景对比设定，观感最稳
- 缺点：无法精确取任意颜色；用户明确要求 hex 取色器
- 为何不选：未说明

### 方案 仅预设色板
- 优点：最简，保证配色可控
- 缺点：不够灵活，无法自定义颜色
- 为何不选：未说明

## 影响
- src-backend/qomicex-backend/src/settings.rs（新增 theme_color）
- src/api/settings.ts（AppSettings.themeColor）
- src/lib/themeColor.ts（新增）
- src/App.tsx（应用主题色）
- src/pages/Settings.tsx（外观页 UI）
- qomicex-tauri-i18n（7 语言键位）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-21 | v1.0 | 初版创建 | AI Agent |