# Qomicex Launcher — UI Design Specification

## 1. Design Tokens

### 1.1 Color System

All colors use HSL via CSS custom properties. Tailwind maps them with `hsl(var(--<name>))`.

| Token | Dark | Light | Usage |
|-------|------|-------|-------|
| `--background` | `230 20% 6%` | `0 0% 100%` | Page background |
| `--foreground` | `220 20% 93%` | `228 20% 10%` | Primary text |
| `--card` | `228 18% 10%` | `0 0% 98%` | Card background |
| `--card-foreground` | `220 20% 93%` | `228 20% 10%` | Card text |
| `--popover` | `228 18% 10%` | `0 0% 98%` | Dropdown/popup background |
| `--popover-foreground` | `220 20% 93%` | `228 20% 10%` | Popup text |
| `--primary` | `142 71% 48%` | `142 71% 42%` | Accent green (active, CTA) |
| `--primary-foreground` | `230 20% 6%` | `0 0% 100%` | Text on primary bg |
| `--secondary` | `228 18% 14%` | `228 15% 94%` | Secondary bg |
| `--secondary-foreground` | `220 20% 93%` | `228 20% 10%` | Text on secondary bg |
| `--muted` | `228 10% 18%` | `228 15% 94%` | Muted bg (inputs, disabled) |
| `--muted-foreground` | `228 8% 55%` | `228 8% 48%` | Muted text, icon default color |
| `--accent` | `228 18% 14%` | `228 15% 94%` | Hover bg |
| `--accent-foreground` | `220 20% 93%` | `228 20% 10%` | Text on hover bg |
| `--destructive` | `0 84% 60%` | `0 84% 60%` | Danger red |
| `--border` | `228 14% 21%` | `228 12% 88%` | Borders |
| `--input` | `228 14% 21%` | `228 12% 88%` | Form control borders |
| `--ring` | `142 71% 48%` | `142 71% 42%` | Focus ring (primary green) |

### 1.2 Typography

| Context | Class | Size |
|---------|-------|------|
| Page title | `text-2xl font-semibold tracking-tight` | 24px |
| Card title | `font-semibold leading-none tracking-tight` | 16px |
| Dialog title | `text-base font-semibold leading-none tracking-tight` | 16px |
| Body text | `text-sm` | 14px |
| Secondary text | `text-sm text-muted-foreground` | 14px |
| Small label | `text-xs text-muted-foreground` | 12px |
| Tiny label | `text-[10px]` | 10px |
| Code/log | `font-mono text-xs` | 12px |
| Font stack | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif` | — |
| Rendering | `-webkit-font-smoothing: antialiased` | — |

### 1.3 Border Radius

| Level | Token | Value | Usage |
|-------|-------|-------|-------|
| Small | `rounded-sm` | 4px | — |
| Medium | `rounded-md` | 6px | Input, Button, Select trigger, Badge, Checkbox |
| Large | `rounded-lg` | 8px | Card inner elements, Dropdown menu, Tabs button, Tooltip |
| Extra large | `rounded-xl` ~ `--radius` | 10px | Card, Dialog, Sidebar, BatchToolbar |
| Full | `rounded-full` | 9999px | Badge pill, Avatar, Slider thumb |

### 1.4 Shadows

| Level | Class | Usage |
|-------|-------|-------|
| Low | `shadow-sm` | Input, Card inner elements |
| Medium | `shadow` | Card |
| High | `shadow-lg` | BatchToolbar, dropdown |
| Very high | `shadow-xl` | Dropdown menu |
| Maximum | `shadow-2xl` | Dialog panel |
| Sidebar | `shadow-xl shadow-black/20` | Sidebar |

### 1.5 Spacing Scale

- Page padding: `p-8` (32px)
- Card padding: `p-6` (24px)
- Section gap: `space-y-6` (24px)
- Element gap: `gap-3` (12px), `gap-2` (8px), `gap-1.5` (6px)
- Button padding: `px-4 py-2` / `px-3 text-xs` (sm)
- Dialog padding: `px-6 py-4`

### 1.6 Z-Index Layers

| Level | Value | Elements |
|-------|-------|----------|
| Base | `z-0` | Backgrounds |
| Content | `z-10` | Page content, Sidebar |
| Fixed | `z-50` | BatchToolbar, Dropdown menus |
| Modal | `z-50` | Dialog overlay |
| Tooltip | `z-[9999]` | Tooltips, FPS overlay |

---

## 2. Component Specs

### 2.1 Button

Uses CVA with the following variants:

| Variant | Default | Hover | Disabled |
|---------|---------|-------|----------|
| `default` | `bg-primary text-primary-foreground shadow` | `hover:bg-primary/90` | `opacity-50 pointer-events-none` |
| `destructive` | `bg-destructive text-destructive-foreground shadow-sm` | `hover:bg-destructive/90` | same |
| `outline` | `border border-input bg-background shadow-sm` | `hover:bg-accent hover:text-accent-foreground` | same |
| `secondary` | `bg-secondary text-secondary-foreground shadow-sm` | `hover:bg-secondary/80` | same |
| `ghost` | `text-muted-foreground` | `hover:bg-accent hover:text-accent-foreground` | same |
| `link` | `text-primary underline-offset-4` | `hover:underline` | same |

- Icon inside button inherits button's `color` (CSS inheritance)
- All buttons: `transition-all duration-150 active:scale-95 focus-visible:ring-1 focus-visible:ring-ring`
- Icon-only: `size="icon"` → `h-9 w-9`
- SVG in button: `[&_svg]:size-4 [&_svg]:shrink-0`

### 2.2 Card

```html
<div class="rounded-xl border bg-card text-card-foreground shadow">
  <div class="p-6 flex flex-col space-y-1.5">  <!-- CardHeader -->
    <h3 class="font-semibold leading-none tracking-tight">  <!-- CardTitle -->
    <p class="text-sm text-muted-foreground">  <!-- CardDescription -->
  </div>
  <div class="p-6 pt-0">  <!-- CardContent -->
  <div class="flex items-center p-6 pt-0">  <!-- CardFooter -->
</div>
```

- Heading icons inside CardTitle use `text-muted-foreground` (not `text-primary`)

### 2.3 Dialog

```html
<!-- Overlay -->
<div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm animate-in fade-in" />

<!-- Panel -->
<div class="fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]
            w-full max-w-lg rounded-xl border bg-popover/90 backdrop-blur-lg
            shadow-2xl animate-in zoom-in-95">
  <div class="border-b border-border px-6 py-4" data-tauri-drag-region>  <!-- Header -->
    <button class="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" />
  </div>
  <div class="px-6 py-4">  <!-- Body -->
  <div class="flex items-center justify-end gap-2 border-t border-border px-6 py-4">  <!-- Footer -->
</div>
```

### 2.4 Input / Select / Combobox

All form controls share a consistent look:

| Property | Value |
|----------|-------|
| Height | `h-9` |
| Border | `rounded-md border border-input` |
| Background | `bg-background` |
| Padding | `px-3 py-1` |
| Font | `text-sm shadow-sm transition-colors` |
| Focus | `focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring` |
| Disabled | `disabled:cursor-not-allowed disabled:opacity-50` |
| Placeholder | `placeholder:text-muted-foreground` |

Dropdown menus:

```
fixed z-50 mt-1 w-full min-w-[180px] rounded-lg border border-border/50
bg-popover/90 backdrop-blur-lg p-1 shadow-xl animate-in fade-in zoom-in-95
```

Dropdown options:

| State | Class |
|-------|-------|
| Selected | `bg-primary/10 font-medium text-primary` |
| Unselected | `text-foreground hover:bg-accent` |
| Disabled | `cursor-not-allowed text-muted-foreground/50` |

### 2.5 Tabs

| Orientation | Layout |
|-------------|--------|
| Horizontal | `flex-row` |
| Vertical | `flex-col` |

- Active indicator: `absolute bg-primary/10 rounded-lg transition-all duration-200`, positioned dynamically via JS
- Tab button: `rounded-lg px-3.5 py-2.5 text-sm transition-all duration-200 relative z-10`
- Active label: `font-medium text-primary`
- Inactive label: `text-muted-foreground hover:bg-accent hover:text-foreground`
- Disabled tab: `cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground`
- TabContent: `animate-in slide-in-right` on switch, no animation on first mount

### 2.6 Tooltip

- Portal to `document.body`
- Container: `fixed z-[9999] rounded-md border border-border/50 bg-popover/90 backdrop-blur-lg px-2.5 py-1.5 text-xs font-medium shadow-md whitespace-nowrap animate-in zoom-in-95`
- Positioned via `side` with hardcoded offsets
- `pointer-events-none`

### 2.7 Badge

| Variant | Style |
|---------|-------|
| `default` | `border-transparent bg-primary text-primary-foreground shadow` |
| `secondary` | `border-transparent bg-secondary text-secondary-foreground` |
| `destructive` | `border-transparent bg-destructive text-destructive-foreground` |
| `outline` | `text-foreground` (border-only) |

Base: `inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold`

### 2.8 Checkbox

- Radix UI `@radix-ui/react-checkbox`
- Size: `h-4 w-4`, `rounded border border-primary/50 bg-background`
- Checked: `data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground`
- Focus: `focus-visible:ring-2 focus-visible:ring-ring`
- Checkmark: inline SVG, `h-3 w-3`

### 2.9 BatchToolbar

```
fixed bottom-8 left-1/2 z-50 -translate-x-1/2
rounded-xl border bg-card px-5 py-3 shadow-lg shadow-black/10
transition-all duration-200
```

- Visible: `translate-y-0 opacity-100 scale-100`
- Hidden (0 selected): `translate-y-4 opacity-0 scale-95 pointer-events-none`, DOM removed after 200ms
- Count: `text-sm text-muted-foreground`, number `font-semibold text-foreground`
- Action buttons: `rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground`
- Separator: `h-5 w-px bg-border`

### 2.10 Sidebar

| Element | Class |
|---------|-------|
| Container | `flex w-16 flex-col items-center border-r border-border/50 bg-card/80 backdrop-blur-xl shadow-xl shadow-black/20` |
| Logo | `h-8 w-8 rounded-lg object-cover` |
| Nav icon (default) | `h-11 w-11 rounded-lg text-muted-foreground transition-all duration-200` |
| Nav icon (active) | `bg-primary/10 text-primary` |
| Nav icon (hover) | `hover:bg-accent hover:text-foreground` |
| Indicator bar | `absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-primary transition-all duration-200` |
| Bottom icons | `h-9 w-9 text-base` |
| Ping dot | `absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-green-500 animate-ping` |

### 2.11 PageShell / PageHeader

PageShell:
```
flex min-h-0 flex-1 flex-col animate-in slide-up
```

PageHeader:
```
flex items-center justify-between gap-4
Title: text-2xl font-semibold tracking-tight
Subtitle: text-sm text-muted-foreground
```

Scroll fade mask (optional addition to PageShell):
- `.scroll-fade-mask`: `mask-image: linear-gradient(to bottom, black 95%, transparent 100%)`
- `.scroll-fade-mask-both`: gradient on both top (4%) and bottom (95%)

---

## 3. Animation System

### 3.1 Duration Multiplier

`--anim-duration-multiplier` CSS variable controls all animation speeds. Set to `0` to disable all animations (F8 debug toggle).

### 3.2 Keyframes

| Name | From | To | Usage |
|------|------|----|-------|
| `fadeIn` | `opacity: 0` | `opacity: 1` | `.fade-in` |
| `zoomIn95` | `opacity: 0; scale: 0.95` | `opacity: 1; scale: 1` | `.zoom-in-95` |
| `slideUp` | `opacity: 0; translateY: 8px` | `opacity: 1; translateY: 0` | `.slide-up` |
| `slideUpIn` | `opacity: 0; translateY: 16px` | `opacity: 1; translateY: 0` | `.slide-up-in` |
| `scaleIn` | `opacity: 0; scale: 0.95` | `opacity: 1; scale: 1` | `.scale-in` |
| `slideInRight` | `opacity: 0; translateX: -12px` | `opacity: 1; translateX: 0` | `.slide-in-right` |
| `slideInLeft` | `opacity: 0; translateX: 12px` | `opacity: 1; translateX: 0` | `.slide-in-left` |

### 3.3 Easing

`cubic-bezier(0.16, 1, 0.3, 1)` — Tailwind class: `ease-out-expo`

### 3.4 Animation Patterns by Component

| Component | Animation | Duration |
|-----------|-----------|----------|
| Page enter | `animate-in slide-up` | 150ms |
| TabContent switch | `animate-in slide-in-right` | 150ms |
| Dropdown open | `animate-in fade-in zoom-in-95` | 150ms |
| Dialog open | `animate-in fade-in` (overlay) + `animate-in zoom-in-95` (panel) | 150ms |
| Tooltip | `animate-in zoom-in-95` | 150ms |
| Sidebar indicator | `transition-all duration-200` | 200ms |
| Tabs indicator | `transition-all duration-200` | 200ms |
| Button press | `active:scale-95` | 150ms |
| BatchToolbar | `transition-all duration-200` | 200ms |
| Staggered list | `.anim-stagger > *` — `scaleIn`, delays 0-360ms | 150ms |

### 3.5 Scroll Fade

Used on pages with overflow-y-auto to indicate scrollable content:
- Bottom fade: `.scroll-fade-mask`
- Top + bottom fade: `.scroll-fade-mask-both`

---

## 4. Icon System

### 4.1 Library

FontAwesome 6 Free Solid (`@fortawesome/free-solid-svg-icons`), rendered via `@fortawesome/react-fontawesome`.

### 4.2 Color Rules

| Context | Default Color | Hover Color |
|---------|---------------|-------------|
| Sidebar navigation | `text-muted-foreground` | `text-foreground` |
| Active sidebar | `text-primary` | — |
| Card heading icons | `text-muted-foreground` | — |
| Button icons | Inherit button text color | Inherit button hover color |
| Ghost button icons | `text-muted-foreground` | `text-accent-foreground` |
| Status indicators | Status-specific (emerald, amber, red, blue) | — |

### 4.3 Sizes

| Context | Size Class | Pixel |
|---------|-----------|-------|
| Sidebar nav | `h-5 w-5` | 20px |
| Sidebar bottom | `h-4 w-4` | 16px |
| Button (default) | `h-4 w-4` (via `[&_svg]:size-4`) | 16px |
| Button (sm) | `h-3.5 w-3.5` | 14px |
| Card heading | `h-4 w-4` | 16px |
| Dropdown item | `h-3 w-3` | 12px |
| Checkmark | `h-3 w-3` | 12px |
| Input prefix | `h-3.5 w-3.5` | 14px |

---

## 5. Layout Patterns

### 5.1 App Shell

```
┌─────────────────────────────────┐
│  TitleBar (Windows only)        │  h-9
├──────┬──────────────────────────┤
│      │  Page Content            │
│ S    │  (PageShell)             │
│ i    │  overflow-y-auto         │
│ d    │  animate-in slide-up     │
│ e    │                          │
│ b    │  scroll-fade-mask        │
│ a    │  (optional)              │
│ r    │                          │
│      │                          │
│ w-16 │                          │
└──────┴──────────────────────────┘
```

### 5.2 Page Padding

- Default: `p-8 space-y-6`
- Account/Instance detail: `p-8 space-y-6` with `overflow-y-auto`
- PageShell wraps content: `flex min-h-0 flex-1 flex-col animate-in slide-up`

### 5.3 Dashboard

```
┌──────────────────────────────────┐
│  Instance Card                   │
│        launch button             │
├────────────────┬─────────────────┤
│                │ Account Widget  │
│                │ Announcement    │
│                │ (fixed right)   │
└────────────────┴─────────────────┘
```

- Account widget: `absolute right-8 top-24 w-72`, card style with dropdown
- Announcement card: same right column, card style with backdrop-blur

### 5.4 Detail Pages (AccountDetail, InstanceDetail)

```
┌──────────────────────────────────┐
│ ← Back button (ghost icon)       │
├──────────────────────────────────┤
│ Tabs (horizontal/vertical)       │
│ ┌──────┬───────────────────────┐ │
│ │ Tab1 │ Content               │ │
│ │ Tab2 │ (TabContent)          │ │
│ │ Tab3 │                       │ │
│ │      │  BatchToolbar (fixed) │ │
│ └──────┴───────────────────────┘ │
└──────────────────────────────────┘
```

- `h-screen p-8 space-y-6 overflow-y-auto scroll-fade-mask`
- Back button: ghost icon style, `h-8 w-8`

---

## 6. Interaction States

| State | Visual |
|-------|--------|
| Default | As specified per component |
| Hover | `hover:bg-accent hover:text-foreground` (interactive elements) |
| Active/Pressed | `active:scale-95` (buttons) |
| Focus | `focus-visible:ring-1 focus-visible:ring-ring` (form controls) |
| Selected | `bg-primary/10 text-primary font-medium` (options, tabs) |
| Disabled | `disabled:cursor-not-allowed disabled:opacity-50 pointer-events-none` |
| Loading | `animate-spin` on icon + disabled state |

---

## 7. Dark Mode

- Default: `.dark` class on `<html>`
- Toggle: `darkMode: "class"` in Tailwind config
- No separate `.dark` CSS needed — colors are defined in `:root, .dark` block
- `.light` class overrides for testing (not used in production)

---

## 8. Debug Features (F8)

| Feature | Mechanism |
|---------|-----------|
| Toggle | Press F8 8 times fast, unlocks debug panel |
| Disable animations | Toggle → sets `--anim-duration-multiplier: 0` |
| Show component boundaries | Adds `* { outline: 1px solid rgba(255,0,0,0.3) }` |
| Log overlay | Fixed bottom-right log overlay |
| FPS overlay | `fixed top-3 right-3 z-[9999]` semi-transparent badge, color-coded (red < 30, yellow < 55, green) |

All debug toggles are temporary (reset on page reload).
