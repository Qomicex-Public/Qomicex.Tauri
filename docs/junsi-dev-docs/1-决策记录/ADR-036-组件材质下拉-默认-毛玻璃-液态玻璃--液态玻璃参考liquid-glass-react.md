# ADR-036：组件材质下拉（默认/毛玻璃/液态玻璃）：液态玻璃参考liquid-glass-react

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-08-21 |
| 决策者 | AI Agent |

## 背景

毛玻璃功能在 ADR-035 中以 glassEffect 开关+glassBlur 落地。用户要求改为「组件材质」下拉（默认/毛玻璃/液态玻璃），液态玻璃严格参考 rdev/liquid-glass-react 手法不要做四不像；并在加液态玻璃前先提交毛玻璃 checkpoint（已提交 50fbce7）。

## 决策

把 glassEffect(bool) 重构为 componentMaterial 枚举 'default'|'frosted'|'liquid'（后端 Option<String>，保留 glass_blur）。frosted=毛玻璃（半透明+backdrop blur）；liquid=液态玻璃，按 liquid-glass-react 手法自研：多向半透明渐变基底 + blur(saturate brightness) + inset 顶部镜面 + 白色调边框投影，叠加鼠标跟随镜面高光（伪元素 ::after 的 radial-gradient 中心随 --gx/--gy 移动，前端在 document pointermove 上对悬浮 .glass-surface 用 rAF 节流写百分比，hover/focus-within 淡入）。checkpoint 50fbce7 先提交 frosted，liquid 在其后叠加。

## 备选方案

### 方案 集成 rdev/liquid-glass-react
- 优点：现成效果
- 缺点：逐组件包裹、portal 冲突、性能与三 webview 渲染风险、网络受限无法实测
- 为何不选：未说明

### 方案 液态仅静态渐变（无鼠标高光）
- 优点：更省
- 缺点：不像真液态玻璃（四不像），用户否决
- 为何不选：未说明

## 影响
- src/index.css（liquid 规则）
- src/App.tsx（--gx/--gy pointer 跟随）
- src/pages/Settings.tsx（液态选项）
- qomicex-tauri-i18n（7 语言）
- 后端 settings.rs（component_material，随 50fbce7 已提交）

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-08-21 | v1.0 | 初版创建 | AI Agent |