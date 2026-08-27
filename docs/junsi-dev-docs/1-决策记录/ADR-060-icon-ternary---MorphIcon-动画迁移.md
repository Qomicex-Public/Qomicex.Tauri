# ADR-056：icon ternary → MorphIcon 动画迁移

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-27 |
| 决策者 | AI Agent |

## 背景

项目从 FontAwesome 迁移到 Lucide 后，需进一步将 icon↔icon 状态切换（如 loading/not-loading 时显示不同图标）升级为 spring 动画过渡，避免图标突变。morphicons 库已依赖（v1.7.0），且项目已有 5 处既有 MorphIcon 用法（InstanceDetail/Settings/Instances/DownloadCenter/TitleBar）。

## 决策

将 6 文件中 8 处 icon↔icon 三元表达式替换为单一 `<MorphIcon>` 组件，icon prop 在 data 图标间切换，className 条件式附加 animate-spin。转换规则：① 从 lucide 包导入 data 图标（别名加 Data 后缀）；② 保留两分支共享 className，将 animate-spin 条件化；③ 被转换的 lucide-react 图标若仅 ternary 使用则移除，残留引用则保留。

## 备选方案

### 方案 保持现状（不升级）
- 优点：零改动
- 缺点：图标突变，无动画过渡
- 为何不选：用户体验差

### 方案 全文替换所有图标为 MorphIcon（含静态）
- 优点：统一所有图标组件
- 缺点：静态图标也引入 MorphIcon 运行时开销，无收益
- 为何不选：ponytail：YAGNI，无须改不需动画的静态图标

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-27 | v1.0 | 初版创建 | AI Agent |