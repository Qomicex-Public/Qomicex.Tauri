# ADR-057：Settings 页重构为 Split View + List + Switch

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-27 |
| 决策者 | AI Agent |

## 背景

用户要求优化设置页：减少卡片、减少边框、多用 Switch 减少功能开关视觉负担、用 List/Split View 改写设置结构。经 CLARIFY 确认方案 A + Switch 加入 plugin-ui + 重构主要 tab。

## 决策

Settings 页重构为 Split View + 扁平 List：保留左 Tabs 导航，右侧去掉 Card 边框改为 SettingSection（单薄边框容器+行分隔线）+ SettingRow 行（label/description/control 右对齐）。15 个 Checkbox 全部替换为新增的 Switch 组件（@radix-ui/react-switch 实现，加入 plugin-ui）。重构范围限 launcher/java/appearance 三个主 tab；toolbox/plugins/about/logs/debug 子组件保持现状。

## 备选方案

### 方案 B: 无卡片+子页（iOS 风格二级列表）
- 优点：动效强
- 缺点：改动最大（需子页路由/返回逻辑）
- 为何不选：不选

### 方案 A: 中央 Icon 适配器
- 优点：全项目图标统一入口
- 缺点：抽象层多一层
- 为何不选：本次为结构重构，与图标无关

## 影响
- plugin-ui 新增 Switch 组件并导出（基于 @radix-ui/react-switch）
- 新增 src/components/settings/SettingRow.tsx（SettingSection + SettingRow 原语）
- Settings.tsx：Card 104→44（剩余在 AboutTab），Checkbox 15→0
- launcher/java/appearance 三个 tab 全部改为 List 结构
- 逻辑/state/i18n key 全部保留，仅改 JSX 结构

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-27 | v1.0 | 初版创建 | AI Agent |

### 2026-08-27 更新
## 范围扩展（b7000ec）

原 ADR 限 launcher/java/appearance 三 tab。用户验收效果好，要求覆盖其余设置页。现已全部完成：

- **AboutTab**（Settings.tsx 内）：11 个 Card → SettingSection，版权/隐私行用 SettingRow
- **ToolboxTab / PluginStoreTab / LogTab**：各 1 个 Card → SettingSection
- **DebugTab**：4 个 Card → SettingSection，1 个 Checkbox → Switch
- **结果**：Settings.tsx + 4 个子组件全部 Card-free（0 残留）
- 复杂内层布局（info grids、依赖 accordion、日志列表、avatar 列表、按钮组）保持原样，仅去 Card 边框

