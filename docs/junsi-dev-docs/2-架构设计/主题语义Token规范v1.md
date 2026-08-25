# 主题语义 Token 规范 v1 + .qtheme（颜色主题）

> 关联：ADR-033/034/035/036/018、`docs/2-架构设计/插件生态技术提案.md` §2、PHASE1 任务②
> 实现：`src/theme/`（schema.ts / manager.ts / themes/*.json）
> 状态：v1 已落地（颜色主题）

## 1. 目标

把当前平铺 HSL 变量升级为 **primitive → semantic → component 三级语义**，以 `.qtheme` 主题包承载，让启动器与插件 UI 经 `var(--*)` 全量即时换肤，**无需重建 plugin-ui dist**。

## 2. 三级语义模型

```
primitives（原始色板，主题包可选）
  └─ 具体色值（HSL/hex），仅供派生
semantic（语义层，.qtheme 作者书写）
  └─ 语义角色：background/foreground/accent/status...（点分命名）
component（组件消费层 = CSS 变量，唯一被 var() 读取）
  └─ --background / --accent-foreground ...（平铺，与 index.css 一一对应）
```

**v1 落点**：`.qtheme` 直接表达 semantic/component 层（即 `--*` 平铺变量），primitive 派生与 `theme.mjs` 计算层留待 v2。

## 3. 语义 token 命名

点分命名，`.` 归一化为 `-`（`background.emphasis` → `--background-emphasis`）。

### 3.1 色板 token（标准组件级集合 = plugin-ui 消费全集）

| token（theme.json 键） | CSS 变量 | 默认值(dark) | 语义 |
|---|---|---|---|
| background | `--background` | `230 20% 6%` | 页面底色 |
| foreground | `--foreground` | `220 20% 93%` | 主文字 |
| card / card-foreground | `--card` / `--card-foreground` | `228 18% 10%` / `220 20% 93%` | 卡片 |
| popover / popover-foreground | `--popover` / `--popover-foreground` | `228 18% 10%` / `220 20% 93%` | 浮层 |
| primary / primary-foreground | `--primary` / `--primary-foreground` | `142 71% 48%` / `230 20% 6%` | 主强调 |
| secondary / secondary-foreground | `--secondary` / `--secondary-foreground` | `228 18% 14%` / `220 20% 93%` | 次级 |
| muted / muted-foreground | `--muted` / `--muted-foreground` | `228 10% 18%` / `228 8% 55%` | 弱化 |
| accent / accent-foreground | `--accent` / `--accent-foreground` | `228 18% 14%` / `220 20% 93%` | 强调底 |
| destructive / destructive-foreground | `--destructive` / `--destructive-foreground` | `0 84% 60%` / `220 20% 93%` | 危险 |
| border | `--border` | `228 14% 21%` | 边框 |
| input | `--input` | `228 14% 21%` | 输入框 |
| ring | `--ring` | `142 71% 48%` | 焦点环 |

扩展语义（v1 可选，emit 为 `--foreground-accent` 等，供前瞻）：`foreground.accent`、`foreground.muted`、`foreground.destructive`、`background.elevated`、`background.emphasis`、`background.sunken`、`border.strong`、`border.accent`、`accent.hover`、`accent.active`、`status.success`、`status.warning`、`status.error`。

### 3.2 非色 token

| token | CSS 变量 | 默认值 | 说明 |
|---|---|---|---|
| radius | `--radius` | `0.625rem` | 圆角 |
| glass-blur | `--glass-blur` | `18px` | 毛玻璃模糊（对齐 ADR-035/036） |

`space.*`、`font.family/size/weight`、`motion.*`（并入既有 `--anim-duration-multiplier`）、`shadow.*` 归入 v2 非色扩展。

## 4. `.qtheme` 格式 v1

```
.qtheme（zip 或目录）
  theme.json        ← 颜色主题（本任务，schema v1，手写校验）
  theme.css         ← 可选，命名空间注入（--qtx- 前缀 / scoped），v2
  theme.mjs         ← 可选，CSS-in-JS 计算层（沙箱），TODO（v2）
  icon-theme.json   ← 图标主题，v2
  fonts/            ← 字体贡献，v2
```

### theme.json schema v1

```jsonc
{
  "schemaVersion": 1,          // 必填，当前仅 1
  "id": "catppuccin-mocha",    // 必填，^[a-z0-9][a-z0-9-]*$
  "name": "Catppuccin Mocha",  // 必填
  "type": "color",             // 可选，当前仅 "color"
  "scheme": "dark",            // 可选，"dark" | "light"
  "colors": {                  // 必填非空，键=语义 token（可点分）
    "background": "240 23% 9%",
    "accent.foreground": "240 23% 9%"   // 归一化为 --accent-foreground
  },
  "radius": 10,                // 可选，数字 rem
  "glassBlur": 18              // 可选，数字 px
}
```

校验规则（`src/theme/schema.ts`，非法抛 `ThemeError` 友好错误）：
- 顶层对象；`schemaVersion` 必须为 1；`id`/`name` 合法；`scheme` ∈ {dark, light}；`colors` 非空对象，每个值必须非空字符串，键须匹配 `^[a-z][a-z0-9.-]*$`。

## 5. 主题管理器（src/theme/manager.ts）

- `applyTheme(json)`：校验 + 注入 `<style id="qomicex-theme-custom">`（裸 `:root{}`，head 末尾源顺序胜出）→ 全组件即时换肤；持久化 id 到 `localStorage['qomicex-active-theme']`。
- `clearTheme()`：移除自定义主题，回到设置层 light/dark/预设。
- `restoreSavedTheme()`：启动时恢复已注册主题（App.tsx mount 调用）。
- `useTheme()`：订阅变更事件驱动重渲染。
- `registerTheme()`：注册打包内置 `.qtheme`（含 Catppuccin 四预设）。

## 6. plugin-ui var() 消费审计

**结论：通过。** 对 `packages/plugin-ui/src/` 全量（.tsx/.ts/.css）扫描内联色值字面量（`#hex`、`rgb(`、`rgba(`、`hsl(数字`、`colorScheme`、`backgroundColor`），仅命中：
- `tailwind-preset.ts`：全部 `hsl(var(--...))`，var() 消费 ✓
- `lib/useMaterial.ts`：`--glass-blur` getPropertyValue，var() 消费 ✓

组件零内联色值 → 换主题 = 即时换肤，无需重建 dist。

## 7. 验证

- `node --experimental-strip-types src/theme/selfcheck.ts` → `ok`（解析/归一化/非法拒绝）
- `pnpm run build`（tsc + vite）通过
- `pnpm --filter @qomicex/plugin-ui build` 通过（本任务未改组件）

## 8. v2 待办

- `theme.mjs` 计算层（沙箱，读启动器 accent/背景推导派生 token）
- 图标主题 `icon-theme.json`、字体贡献 `fonts/`
- 非色 token 全量（space/font/motion/shadow）
- Settings UI 选择器接入（本任务仅提供 useTheme 能力，未接 UI）
