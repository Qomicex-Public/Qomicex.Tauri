# ADR-069：plugin-ui 动画速度口径统一与组件细节动效增强

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-09-10 |
| 决策者 | AI Agent |

## 背景

plugin-ui 存在两套动画驱动：GSAP（Dialog/Popover/Select/Combobox）与 CSS keyframes（Tooltip/Tabs/Badge/Input）。二者的时长换算口径不一致导致实际行为相反：宿主 App.tsx 写入 --anim-duration-multiplier = (1/speed)*fpsScale（数值越大越慢，CSS 用 calc(ms * multiplier) 正确），但 anim.ts 的 readAnimConfig 把该乘数当 speed，4 个 GSAP 组件用 duration / speed —— 用户调慢（multiplier>1）时 GSAP 反而变快，调快时反而变慢。另发现 src/index.css 的 .anim-stagger 第 3~10 项 animation-delay 误写为 px 单位，导致这些项的 stagger 延迟全部失效。此外 Label/Input/Textarea/Badge 缺少细节动效。

## 决策

1. 统一口径：anim.ts 的 AnimConfig 字段由 speed 改名为 multiplier，语义与 CSS 变量对齐（越大越慢）；4 个 GSAP 组件时长由 duration / speed 改为 duration * multiplier，消除方向反转。2. 修 .anim-stagger 第 3~10 项 animation-delay 的 px→ms。3. Label 新增默认开启的文字切换动画：纯文本子节点用文本作 React key 的 span 包裹，内容变更即重挂载并重放 animate-label-swap（180ms 上滑淡入）；提供 animate={false} 关闭。4. Input/Textarea 聚焦时套用 animate-focus-glow（450ms ring 辉光脉冲）。5. Badge 入场套用 animate-zoom-fade-in。6. 新增 label-swap / focus-glow 两个 keyframe，同步写入 packages/plugin-ui/src/tailwind-preset.ts 与根 tailwind.config.js（延续 ADR-068 的 preset 自含策略）。

## 备选方案

### 方案 保留 speed 命名，改为 multiplier = 1/speed 再做除法
- 优点：组件内算式不变
- 缺点：多一层取倒数，语义仍绕
- 为何不选：直接对齐 CSS 变量语义更直观，改名一次到位

### 方案 Tooltip 也补退场动画
- 优点：与 Dialog/Popover 一致
- 缺点：标准 tooltip 即时消失是合理 UX；加退场会引入 mouseleave/re-enter 竞态
- 为何不选：非 bug，属设计选择，保持现状

### 方案 Label 动画默认关闭
- 优点：零观感回归
- 缺点：与用户要的"改内容就有动画"相悖
- 为何不选：用户明确选择默认开启

## 影响
- packages/plugin-ui/src/lib/anim.ts
- packages/plugin-ui/src/components/Dialog.tsx
- packages/plugin-ui/src/components/Popover.tsx
- packages/plugin-ui/src/components/Select.tsx
- packages/plugin-ui/src/components/Combobox.tsx
- packages/plugin-ui/src/components/Label.tsx
- packages/plugin-ui/src/components/Input.tsx
- packages/plugin-ui/src/components/Textarea.tsx
- packages/plugin-ui/src/components/Badge.tsx
- packages/plugin-ui/src/tailwind-preset.ts
- tailwind.config.js
- src/index.css

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-09-10 | v1.0 | 初版创建 | AI Agent |

### 2026-09-10 更新
## 追加修复：Tooltip 动画错位（v1.1）

### 问题
Tooltip 出现「先渲染在错误位置、随后跳到鼠标/元素位置」的一帧跳变。

### 根因
`Tooltip.tsx` 把定位用的 `transform: translateX(-50%)`（inline style）与动画 `animate-zoom-fade-in`（keyframe 内 `transform: scale()`）放在**同一元素**上。CSS 动画的 `transform` 声明优先级高于 inline style，动画期间 `translateX(-50%)` 被覆盖 → 提示框右移约自身半宽；动画结束、transform 回落到 inline 值 → 跳回居中。此冲突在 ADR-068 之前被掩盖：旧类 `animate-in zoom-in-95` 因全仓库无对应 keyframes 根本没跑动画，ADR-068 让 `zoom-fade-in` 真正生效后暴露。次因：`useTooltipPosition` 初始 `style` 仅有 `{position:'fixed'}`，坐标在 `useEffect`（paint 后）才算，首帧无坐标。

### 决策
1. Tooltip 分层：外层 div 只负责 `position: fixed` + 定位（含 `translateX(-50%)`），内层 div 只负责视觉与 `animate-zoom-fade-in`。定位 transform 与动画 transform 不再竞争。
2. `useTooltipPosition` 的定位 effect 由 `useEffect` 改为 `useLayoutEffect`，坐标在 paint 前算出，消除首帧无坐标。

### 验证（Playwright + 本机 Chrome）
- 修复后：Tooltip 外层 `getBoundingClientRect().left` 动画前后均为 329.1，位移 0px；内层仅按 scale 中心缩放。
- 反向取证：复刻旧同元素结构，left 由 500.78 → 473.15（-27.63px ≈ 半宽），复现「错位后跳正」。

### 影响（追加）
- packages/plugin-ui/src/components/Tooltip.tsx
- packages/plugin-ui/src/hooks/useFloatingPosition.ts
