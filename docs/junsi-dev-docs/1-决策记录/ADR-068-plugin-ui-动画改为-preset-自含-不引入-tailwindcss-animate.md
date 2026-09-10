# ADR-068：plugin-ui 动画改为 preset 自含，不引入 tailwindcss-animate

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-10 |
| 决策者 | AI Agent |

## 背景

plugin-ui 的 Tooltip（animate-in zoom-in-95）和 Tabs 的 TabContent（animate-in slide-in-right）使用了 tailwindcss-animate 插件的类名，但全仓库未安装该插件（根 tailwind.config.js plugins 为空），导致这两个动画完全无效。同时 gsap 被 Dialog/Popover/Select/Combobox 运行时 import，但未声明在 plugin-ui 的 package.json 中，外部插件从 npm 安装 @qomicex/plugin-ui 后会缺依赖。目标是让外部插件 npm 安装 plugin-ui + 使用 tailwind-preset 后开箱即得完整动画。

## 决策

1. 在 tailwind-preset.ts 中自定义 zoom-fade-in（150ms, scale 0.95→1 + fade）与 slide-in-right（200ms, translateX 1rem→0 + fade）两个 keyframe，时长经 calc() 联动全局 --anim-duration-multiplier，缓动统一用现有 out-expo 曲线（cubic-bezier(0.16,1,0.3,1)）。不引入 tailwindcss-animate：它没有 slide-in-right 类名（只有 slide-in-from-right-*），且多一个运行时依赖；自定义仅 8 行。2. Tooltip.tsx 与 Tabs.tsx（TabContent）类名改为 animate-zoom-fade-in / animate-slide-in-right。3. 根 tailwind.config.js 同步补同样 keyframes（主仓库未使用 preset，与现有 borderRadius 手工同步的模式一致）。4. plugin-ui package.json dependencies 加 gsap ^3.15.0 并 bump 0.2.5。

## 备选方案

### 方案 引入 tailwindcss-animate 插件
- 优点：shadcn 生态标准、类名丰富
- 缺点：多余依赖 + 仍需改组件类名
- 为何不选：类名不匹配（slide-in-right 不存在，需改代码适配 slide-in-from-right-*）且为两个动画引入额外依赖

### 方案 主仓库改用 tailwind-preset
- 优点：消除配置重复
- 缺点：视觉回归风险
- 为何不选：主仓库与 preset 的 borderRadius 定义不同（xl: +2px vs +4px），改用 preset 会改变主仓库视觉行为，风险大于收益

## 影响
- packages/plugin-ui/src/tailwind-preset.ts
- packages/plugin-ui/src/components/Tooltip.tsx
- packages/plugin-ui/src/components/Tabs.tsx
- packages/plugin-ui/package.json
- tailwind.config.js
- pnpm-lock.yaml

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-10 | v1.0 | 初版创建 | AI Agent |