# 主题语义 Token

规范源：`docs/junsi-dev-docs/2-架构设计/主题语义Token规范v1.md`（实现：`src/theme/`）。插件 UI 主题的**唯一正确做法**：全量经 `var(--*)` 消费语义 token，禁止内联色值。

## 三级语义模型

```
primitives（原始色板）→ semantic（语义角色）→ component（CSS 变量，唯一被 var() 读取）
```

v1 落点：`.qtheme` 主题直接表达 semantic/component 层（即 `--*` 平铺变量）。插件不写主题，只**消费**这些变量。token 点分命名，`.` 归一化为 `-`（`background.emphasis` → `--background-emphasis`）。

## 色板 token（plugin-ui 消费全集）

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

扩展语义（可选，emit 为 `--foreground-accent` 等）：`foreground.accent`、`foreground.muted`、`foreground.destructive`、`background.elevated`、`background.emphasis`、`background.sunken`、`border.strong`、`border.accent`、`accent.hover`、`accent.active`、`status.success`、`status.warning`、`status.error`。

## 非色 token

| token | CSS 变量 | 默认值 | 说明 |
|---|---|---|---|
| radius | `--radius` | `0.625rem` | 圆角 |
| glass-blur | `--glass-blur` | `18px` | 毛玻璃模糊 |

## var() 消费约定

- **全部用 `var(--*)`，禁止内联色值**（`#hex` / `rgb()` / `hsl()` 字面量）。plugin-ui 组件已全量 var() 消费，换主题即时生效，无需重建 dist。
- 颜色值多为 HSL 三元组（如 `142 71% 48%`），组件库经 `hsl(var(--primary))` 解析。插件自定义 CSS 需要时同样写 `hsl(var(--primary) / <alpha>)` 形式。
- Tailwind 侧直接用语义类名：`bg-primary`、`text-foreground`、`bg-muted`、`text-muted-foreground`、`border-border` 等（`@qomicex/plugin-ui/tailwind-preset` 已映射）。

## 主题贡献（entry.theme）

- manifest `entry.theme` 指向 `dist/theme.css`，激活时注入 `<style data-plugin-theme>`。
- 主题 CSS 只能**覆盖/补充** token，仍须全部 `var()` 引用，禁止内联色值：

```css
:root[data-theme] {
  /* 可选：覆盖默认 HSL token */
  --primary: 142 71% 48%;
}
```

- `qomicex pack` 会自动把根目录的 `theme.css` 拷入 `dist/theme.css`（若 manifest 引用 `dist/theme.css`）。
- **不要在插件里定义与启动器冲突的平铺变量**；需要私有样式时走组件 class（Tailwind）或局部作用域。
