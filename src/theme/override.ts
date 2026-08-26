/**
 * 插件驱动的全局主题覆盖（applyThemeOverride）。
 *
 * 与内置主题流的关系：
 *  - 注入 `<style id="qomicex-plugin-theme-override">`，选择器 `:root:root` 非分层规则，
 *    特异性 (0,2,0) 高于 manager 的自定义 .qtheme（:root）与 index.css 内 @layer base 的全部定义。
 *  - themeColor.ts 的 inline style（--primary/--ring/--primary-foreground）优先级最高，
 *    故 override 中这三者只在用户未设置主题色时生效（inline 缺席）。
 *  - 插件停用 / 重新应用时调用 clearThemeOverride() 移除。
 *
 * 安全性：仅接受白名单 token + 严格 `H S% L%` 格式，拒绝任意 CSS 注入。
 */

const STYLE_ID = 'qomicex-plugin-theme-override'
const SELECTOR = ':root:root'

const HSL_RE = /^\d{1,3} \d{1,3}% \d{1,3}%$/

/** token 白名单（CSS 变量横杠命名；插件侧点分命名在归一化后校验）。 */
const TOKEN_WHITELIST = new Set([
  'background', 'foreground',
  'card', 'card-foreground', 'popover', 'popover-foreground',
  'primary', 'primary-foreground', 'secondary', 'secondary-foreground',
  'muted', 'muted-foreground', 'accent', 'accent-foreground',
  'destructive', 'destructive-foreground', 'border', 'input', 'ring',
  'background-elevated', 'background-emphasis', 'background-sunken',
  'foreground-muted', 'foreground-accent', 'foreground-destructive',
  'border-strong', 'border-accent', 'accent-hover', 'accent-active',
  'status-success', 'status-warning', 'status-error',
])

function normalizeToken(token: string): string {
  return token.replace(/\./g, '-')
}

export function applyThemeOverride(vars: Record<string, string>): void {
  if (!vars || typeof vars !== 'object') return
  const entries: string[] = []
  for (const [token, value] of Object.entries(vars)) {
    const cssName = normalizeToken(token)
    if (!TOKEN_WHITELIST.has(cssName)) continue
    if (typeof value !== 'string' || !HSL_RE.test(value.trim())) continue
    entries.push(`--${cssName}: ${value.trim()};`)
  }
  if (!entries.length) return
  const css = `${SELECTOR} { ${entries.join(' ')} }`
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  el.textContent = css
}

export function clearThemeOverride(): void {
  document.getElementById(STYLE_ID)?.remove()
}