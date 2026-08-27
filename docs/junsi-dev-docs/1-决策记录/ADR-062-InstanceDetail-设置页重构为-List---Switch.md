# ADR-058：InstanceDetail 设置页重构为 List + Switch

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-27 |
| 决策者 | AI Agent |

## 背景

用户要求"同理优化实例详情里面的设置"——把 Settings 页已落地的 List/Switch/Split View 风格应用到 InstanceDetail 的设置 tab 与游戏设置 tab。已确认拆 4 组 + GameSettingsTab 一起转。

## 决策

InstanceDetail 设置 tab 拆为 4 个 SettingSection 组（基础信息/完整性与启动/内存分配/高级），跳过完整性 Checkbox→Switch；GameSettingsTab 外层 Card→SettingSection 保留搜索+行列表。复用 SettingRow 原语与 Switch，与 Settings 页统一。

## 备选方案

### 方案 B: 单组（仅去 Card 边框）
- 优点：改动小
- 缺点：仍是长卡片，未达用户‘减少卡片’目标
- 为何不选：不选

### 方案 A: 拆 4 组 SettingSection
- 优点：与 Settings 页风格统一，视觉负担轻
- 缺点：无（本次 UI 结构重构）
- 为何不选：采用（用户确认）

## 影响
- InstanceDetail.tsx：Card 34→30（overview 与其他子 tab 保留）
- 新增 5 SettingSection + 9 SettingRow + 1 Switch
- skipIntegrityCheck Checkbox→Switch
- GameSettingsTab 去 Card 边框
- 逻辑/state/i18n key 全部保留

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-27 | v1.0 | 初版创建 | AI Agent |