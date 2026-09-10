# ADR-070：实例详情列表内边距统一与概况页重构为 SettingSection

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-11 |
| 决策者 | AI Agent |

## 背景

实例详情页（src/pages/InstanceDetail.tsx）各 tab 的列表内边距不一致：模组/存档/资源包/光影/数据包/投影 tab 的列表容器为 `flex flex-col gap-2 p-4`（卡片两侧 16px 内缩），而服务器 tab 列表容器为 `space-y-2`（无 p-4），卡片撑满 SettingSection 容器；游戏设置 tab 列表容器 `space-y-1` 同样缺 p-4。此外概况 tab 不用 SettingSection，而是 5 个裸 `<Card>`（不透明 bg-card、无分段标题头），与其它 tab 的 SettingSection（半透明 bg-card/40 glass 容器 + 图标+标题头）风格不统一。浏览器实测（真实实例）：服务器卡片相对容器 insetLeft/Right=1px，模组=17px；概况卡片底色为不透明 bg-card。

## 决策

1) 服务器 tab 列表容器 `space-y-2` → `space-y-2 p-4`，骨架图 `flex flex-col gap-1` → `flex flex-col gap-1 p-4`；LAN 游戏区块合并标题与列表进同一 `space-y-2 p-4` 容器，使标题与卡片一起内缩。2) 游戏设置 tab 列表容器与骨架图补 `p-4`。3) 概况 tab 由 5 个裸 Card 重构为 5 个 SettingSection 分段：基本信息(instances.basicInfo/Info)、备注(overview.remark/Pen)、整合包信息(overview.modpackInfo/Package)、快速操作(overview.quickActions/Play)、自定义分组(instances.groups/Layers)，内容统一包 `p-4`，与其它 tab 视觉一致。复用现有 i18n 键，不新增翻译、不改 i18n submodule。保留 Card/CardContent import（服务器 tab 仍在使用）。

## 备选方案

### 方案 仅统一概况页卡片底色为 glass，不重构结构
- 优点：改动最小
- 缺点：无法消除「无分段标题头」的结构差异，风格仍不统一
- 为何不选：用户明确要求风格一致，结构差异是核心问题

### 方案 全实例详情所有列表统一为同一套内边距规范
- 优点：彻底统一
- 缺点：改动面大，游戏设置/服务器等已有各自的紧凑设计意图，收益低
- 为何不选：本次只补缺失的 p-4，不推翻既有设计

## 影响
- src/pages/InstanceDetail.tsx

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-11 | v1.0 | 初版创建 | AI Agent |

### 2026-09-11 更新
## 追加修复：loading 内边距对齐 + 滚动底部留白（v1.1）

### 问题
1. 实例详情各 tab 的 loading 态（spinner / 进度条 / 骨架）容器无 `p-4`，与列表项 `p-4`（16px）左右不对齐；模组 tab 的读取进度条 `h-1 w-full` 撑满容器宽。
2. 页面内容可滚动时，滚动容器（`.overflow-y-auto.scroll-fade-mask`）无底部内边距，最后一个分组贴底；`scroll-fade-mask` 在底部 95%→100% 渐隐，进一步遮挡分组底部。

### 决策
1. 滚动容器加 `pb-8`（32px 底部留白），渐隐作用于留白区而非内容。
2. 全部 loading 态容器统一补 `p-4` 与列表项对齐：saves/schematics 的 spinner 行 `px-4 py-8`；screenshots 骨架 grid 加 `p-4`；mods loading 外层 `space-y-3` → `space-y-3 p-4`，内层骨架去掉 `p-4` 避免双重内缩；servers/gamesettings 原有 `p-4` 保持。

### 验证（Playwright + 本机 Chrome，真实实例）
- 滚动到底：`paddingBottom=32px`，最后分组到容器底部间距 0 → 32px。
- 六个 tab（saves/screenshots/mods/schematics/servers/gamesettings）loading 容器 computed padding-left/right 均为 16px，与列表项一致。

### 影响（追加）
- src/pages/InstanceDetail.tsx
