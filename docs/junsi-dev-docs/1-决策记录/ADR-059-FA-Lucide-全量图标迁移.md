# ADR-055：FA→Lucide 全量图标迁移

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-27 |
| 决策者 | AI Agent |

## 背景

为支持 morphicons（描边图标 morph 库）的集成，需要将全项目 502 处 FontAwesome 实心图标替换为描边图标库，因为 morphicons 只能 morph 描边几何。用户确认迁移策略：直接 lucide-react 组件替换、保留 FA 品牌图标（7 个）、全量迁移。

## 决策

采用"直接 lucide-react 组件"策略（非适配器中间层），保证 tree-shaking 干净。BuiltinIcons/PluginIcon 保持 FA（插件 fa-* 类名→图标的字符串查找契约，迁移会破坏插件兼容）。品牌图标 faMicrosoft/faGithub/faJava/faKeycdn 保留 FA。转换规则统一写入 MAPPING_TABLE.yaml。

## 备选方案

### 方案 A: 中央 Icon 适配器（<Icon name='play' />）
- 优点：每个文件只改 import 行
- 缺点：多一层抽象，tree-shaking 差，增加维护成本
- 为何不选：不选

### 方案 B: 通过 Translator Subagent 逐文件批次迁移
- 优点：符合 code-migrater 流程规范
- 缺点：需额外子代理协调，增加成本
- 为何不选：子代理未配置支付，无法执行

### 方案 C: 主控直接逐文件迁移
- 优点：最直接、最可控
- 缺点：502 处手动替换易出错
- 为何不选：采用（用户选择）

## 影响
- 502 处 FontAwesomeIcon 替换为 lucide-react 组件，45 个文件修改
- 纯描边图标（stroke），视觉轻量化
- morphicons 的 MorphIcon 可与 lucide 数据配合使用（TitleBar max↔restore、下载中心 play↔pause 已集成）
- @fortawesome/free-solid-svg-icons 保留（BuiltinIcons 仍需），@fortawesome/free-brands-svg-icons 保留
- 增加 lucide-react + morphicons 依赖

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-27 | v1.0 | 初版创建 | AI Agent |