# ADR-109：宿主 Tailwind 复用 plugin-ui preset、统一 rounded-xl 口径并收敛设置到 DOM 的双写（issue #238）

| 属性 | 内容 |
|---|---|
| 状态 | 已采纳 |
| 日期 | 2026-10-10 |
| 决策者 | AI Agent |

## 背景

issue #238 指出宿主 `tailwind.config.js` 与 `packages/plugin-ui/src/tailwind-preset.ts` 是同一套 colors/borderRadius/keyframes/animation 的两份拷贝，且 `borderRadius.xl` 已经漂移（宿主 `+2px`、preset `+4px`），宿主与插件包对同一个 `rounded-xl` 的定义不同。ADR-068 曾明确拒绝「主仓库改用 tailwind-preset」，理由正是这个 xl 差异会让主仓库视觉行为改变（风险大于收益）——即阻塞点是 xl 取值不一致，而不是方案本身有缺陷。此外 #238 还指出三处「把 settings 映射到 CSS 变量」的双写（App.tsx / Settings.tsx / Layout.tsx），以及 tauri.conf.json 的 beforeDev/BuildCommand 使用 npm（仓库为 pnpm-managed）。

## 决策

1. 统一 `borderRadius.xl` 取 preset 的 `calc(var(--radius) + 4px)`（宿主原为 +2px）——用户已确认；这同时消除了 ADR-068 拒绝合并的那个阻塞点。2. 宿主 `tailwind.config.js` 改为 `presets: [preset]`（import `@qomicex/plugin-ui/tailwind-preset`），删除本地重复的 colors/borderRadius/keyframes/animation；仅保留 preset 未提供的 `transitionTimingFunction['out-expo']`。3. 抽出 `src/lib/applySettingsToDom.ts` 作为「设置 → CSS 变量/dataset」的唯一实现，App.tsx（onSettingsChange）、Settings.tsx（saveSettings）、Layout.tsx 共用；顺带修好实测漂移——`dataset.animGpu` 此前只在 App.tsx 写入，在设置页关闭 GPU 加速不会即时生效。4. 权限表以 `@qomicex/plugin-ui` 为唯一源，`src/plugins/types.ts` 改为 re-export（实测两份 40 项内容零差异、仅顺序不同）。5. `tauri.conf.json` 的 `beforeDevCommand`/`beforeBuildCommand` 由 `npm run` 改为 `pnpm run`（仓库是 pnpm-managed）。

## 备选方案

### 方案 两处手工同步（现状）
- 优点：零视觉变化
- 缺点：两处主题配置各异，新增一个动画/keframe 都要改两处
- 为何不选：已经实际漂移：borderRadius.xl 宿主 +2px / preset +4px，同一个 rounded-xl 在宿主与插件包定义不同

### 方案 把 selfcheck.ts 纳入类型检查
- 优点：该脚本受类型保护
- 缺点：需要给浏览器类型的 tsconfig 引入 @types/node，或者把 Node 脚本移出 src
- 为何不选：本轮未采纳：selfcheck.ts 使用 node:fs 与 process，而 tsconfig.json 面向 DOM；简单地取消 exclude 会产生两个 TS2307/TS2580 错误（实测）。该脚本本身可独立运行并通过（node --experimental-strip-types 输出 ok），保留原状并在本 ADR 记录

## 影响
- tailwind.config.js
- packages/plugin-ui/src/tailwind-preset.ts（未改，作为唯一源）
- src/lib/applySettingsToDom.ts（新增）
- src/App.tsx
- src/pages/Settings.tsx
- src/components/Layout.tsx
- src/plugins/types.ts
- src-tauri/tauri.conf.json

## 修订记录
| 日期 | 版本 | 修改内容 | 修改人 |
|---|---|---|---|
| 2026-10-10 | v1.0 | 初版创建 | AI Agent |