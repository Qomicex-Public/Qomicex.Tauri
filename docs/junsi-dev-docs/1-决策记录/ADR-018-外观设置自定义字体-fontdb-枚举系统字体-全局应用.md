# ADR-018：外观设置自定义字体（fontdb 枚举系统字体 + 全局应用）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-15 |
| 决策者 | AI Agent |

## 背景

用户要求在外观设置里添加自定义字体功能。现状：字体定义在 `src/index.css` body（`font-family: -apple-system, ...` 系统默认栈），无任何自定义入口；后端 settings 持久化在 `{BaseDir}/QML/settings.json`，已有 `/api/settings` GET/PUT 与背景图机制可仿照。

需求澄清结果：
- **来源**：系统已安装字体选择（非上传文件）。
- **格式**：TTF/OTF 等系统常见格式（fontdb 天然支持）。
- **范围**：全局 UI 字体（整个启动器界面文字换字体）。
- **重置**：外观设置提供「恢复默认字体」按钮。

## 决策

### 1. 后端：fontdb 枚举 + `/api/settings/fonts` 端点

- `Cargo.toml` 新增 `fontdb = "0.20"`（纯 Rust、跨平台枚举系统字体，无系统 API 依赖）。
- `endpoints/system.rs` 新增 `GET /api/settings/fonts`：`fontdb::Database::load_system_fonts()` 取所有字体 family 名 → 排序去重 → `OnceLock` 进程内缓存（首次扫描较慢，之后直接命中）。
- 零新状态、零新配置；端点挂在现有 system router 下，无需改 `app.rs`。

### 2. 设置持久化：`fontFamily`

- `SettingsResponse` 新增 `font_family: Option<String>`（serde camelCase → `fontFamily`）；`Default` 为 `None`。老配置文件缺失该字段时反序列化为 `None`，天然兼容。
- 前端 `AppSettings.fontFamily?: string`，`DEFAULT_SETTINGS.fontFamily = ''`（空 = 系统默认）。

### 3. 前端：外观设置「字体」卡片 + 全局应用

- `src/api/settings.ts` 新增 `getSystemFonts()`。
- `src/pages/Settings.tsx` 外观 tab 新增「字体」卡片（圆角卡片与背景卡片之间）：
  - 可搜索 Select 列出系统字体（无选中时 placeholder「默认字体」）；
  - 选中 → `update('fontFamily', name)` 即时保存 + 全局生效；
  - 预览框用所选字体渲染（`Qomicex 启动器 — 中文示例 123 ABC`）；
  - 已选时显示「恢复默认字体」按钮 → 清空。
- `src/App.tsx`：新增 `applyFont(family)` —— `document.documentElement.style.setProperty('--app-font', ...)`，空则移除；`loadSettings` 与 `onSettingsChange` 均调用。
- `src/index.css`：body 改为 `font-family: var(--app-font, -apple-system, ...)`，未设置时回退原默认栈。

### 4. i18n

- submodule `qomicex-tauri-i18n` 的 `settings.ts` 新增 `appearance.font*` 键（zh/en：font/fontFamily/fontDefault/fontDesc/fontPreviewTitle/fontPreviewText/fontReset）。

## 备选方案

### 方案 前端浏览器 Local Font Access API（queryLocalFonts）
- 优点：纯前端，零后端改动。
- 缺点：需 WebView 支持（Tauri WebView2/WebKit 支持度不稳定）；权限弹窗体验差；浏览器环境无法枚举系统字体。
- 为何不选：fontdb 后端枚举跨平台一致、可测试、与现有设置 API 同构。

### 方案 上传字体文件到 `{BaseDir}/QML/fonts/`
- 优点：可用任意字体文件，不限于系统已装。
- 缺点：增加文件上传/管理/权限复杂度；需求明确选「系统字体选择」。
- 为何不选：用户已确认系统字体选择即可。

## 影响

- 后端：`Cargo.toml`（fontdb）、`Cargo.lock`、`endpoints/system.rs`（/settings/fonts）、`settings.rs`（font_family）。
- 前端：`src/api/settings.ts`、`src/pages/Settings.tsx`（字体卡片）、`src/App.tsx`（applyFont）、`src/index.css`（--app-font）。
- i18n submodule：`settings.ts`（appearance.font*，需单独提交推送）。
- 无新 API 依赖、无构建命令变更。

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-15 | v1.0 | 初版创建 | AI Agent |
