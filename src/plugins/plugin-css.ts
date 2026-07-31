export const pluginCss = `
:root{color-scheme:light dark}
*{margin:0;padding:0;box-sizing:border-box}
html{background:transparent}
body{font-family:system-ui,sans-serif;color:hsl(var(--foreground));background:transparent;height:100%;overflow:hidden}
#root{height:100%}

/* Tabs */
.p-tabs{display:flex;gap:4px;margin-bottom:16px;border-bottom:1px solid hsl(var(--border));padding-bottom:0}
.p-tab{padding:6px 14px;border:none;cursor:pointer;font-size:13px;background:transparent;color:hsl(var(--muted-foreground));border-bottom:2px solid transparent;margin-bottom:-1px;transition:all .15s}
.p-tab.active,.p-tab--active{color:hsl(var(--primary));border-bottom-color:hsl(var(--primary))}
.p-tab:hover:not(.active):not(.p-tab--active){color:hsl(var(--foreground))}

.p-panel{display:none}
.p-panel.active,.p-panel--active{display:block}

/* Card — matches shadcn Card */
.p-card{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:0.625rem;padding:14px;margin-bottom:10px;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.p-card-title{font-size:14px;font-weight:600;color:hsl(var(--card-foreground));margin-bottom:8px;letter-spacing:-.01em}
.p-card-desc{font-size:12px;color:hsl(var(--muted-foreground));margin-bottom:8px}

/* Buttons — shadcn style */
.p-btn{padding:6px 14px;border:none;border-radius:0.375rem;cursor:pointer;font-size:13px;font-weight:500;transition:all .15s;display:inline-flex;align-items:center;gap:6px;height:32px;line-height:1}
.p-btn:active{transform:scale(.95)}
.p-btn--primary{background:hsl(var(--primary));color:hsl(var(--primary-foreground))}
.p-btn--primary:hover{background:hsl(var(--primary) / 0.9)}
.p-btn--default{background:hsl(var(--secondary));color:hsl(var(--secondary-foreground))}
.p-btn--default:hover{background:hsl(var(--secondary) / 0.8)}
.p-btn--ghost{background:transparent;color:hsl(var(--muted-foreground))}
.p-btn--ghost:hover{background:hsl(var(--muted));color:hsl(var(--foreground))}
.p-btn--danger{background:hsl(var(--destructive));color:hsl(var(--destructive-foreground))}
.p-btn--danger:hover{background:hsl(var(--destructive) / 0.9)}
.p-btn--outline{background:transparent;border:1px solid hsl(var(--border));color:hsl(var(--foreground))}
.p-btn--outline:hover{background:hsl(var(--muted))}
.p-btn--sm{height:28px;padding:3px 10px;font-size:12px;border-radius:0.25rem}

/* Input — shadcn Input */
.p-input,.p-textarea{width:100%;background:hsl(var(--background));border:1px solid hsl(var(--input));border-radius:0.375rem;padding:6px 10px;color:hsl(var(--foreground));font-size:13px;outline:none;transition:border-color .15s;height:32px}
.p-input:focus,.p-textarea:focus{border-color:hsl(var(--ring));box-shadow:0 0 0 1px hsl(var(--ring) / 0.2)}
.p-input::placeholder,.p-textarea::placeholder{color:hsl(var(--muted-foreground));opacity:.6}
.p-textarea{resize:vertical;min-height:80px;height:auto;padding:8px 10px}
.p-input--sm{height:28px;padding:4px 8px;font-size:12px}

.p-label{font-size:12px;color:hsl(var(--muted-foreground));margin-bottom:2px;display:block}

/* Badge — shadcn Badge */
.p-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:0.25rem;font-size:11px;font-weight:600;border:1px solid transparent}
.p-badge--green{background:hsl(var(--primary) / 0.12);color:hsl(var(--primary));border-color:hsl(var(--primary) / 0.2)}
.p-badge--red{background:hsl(var(--destructive) / 0.12);color:hsl(var(--destructive));border-color:hsl(var(--destructive) / 0.2)}
.p-badge--yellow{background:rgba(245,158,11,.12);color:#f59e0b;border-color:rgba(245,158,11,.2)}
.p-badge--blue{background:rgba(96,165,250,.12);color:#60a5fa;border-color:rgba(96,165,250,.2)}
.p-badge--default{background:hsl(var(--muted));border:1px solid hsl(var(--border));color:hsl(var(--muted-foreground))}

/* Divider / Separator */
.p-divider{height:1px;background:hsl(var(--border));margin:12px 0}
.p-separator{width:1px;background:hsl(var(--border));margin:0 8px;align-self:stretch}
.p-hr{border:none;height:1px;background:hsl(var(--border));margin:12px 0}

.p-status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;flex-shrink:0}
.p-status-dot--up{background:hsl(var(--primary))}
.p-status-dot--down{background:hsl(var(--destructive))}
.p-status-dot--warn{background:#f59e0b}

.p-pre{font-size:12px;background:hsl(var(--background));border-radius:0.375rem;padding:10px;margin-top:8px;max-height:200px;overflow:auto;white-space:pre-wrap;color:hsl(var(--foreground));line-height:1.5;border:1px solid hsl(var(--border))}

/* Checkbox */
.p-check-field{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:hsl(var(--foreground))}
.p-check-field input[type="checkbox"]{appearance:none;width:16px;height:16px;border:1px solid hsl(var(--border));border-radius:0.25rem;background:hsl(var(--background));cursor:pointer;position:relative;flex-shrink:0;transition:all .15s}
.p-check-field input[type="checkbox"]:checked{background:hsl(var(--primary));border-color:hsl(var(--primary))}
.p-check-field input[type="checkbox"]:checked::after{content:'';position:absolute;left:5px;top:2px;width:4px;height:7px;border:solid hsl(var(--primary-foreground));border-width:0 2px 2px 0;transform:rotate(45deg)}

/* Switch/Toggle */
.p-swiper{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:hsl(var(--foreground))}
.p-swiper-track{width:36px;height:20px;border-radius:99px;background:hsl(var(--muted));transition:background .2s;flex-shrink:0;position:relative}
.p-swiper-track::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:hsl(var(--foreground));transition:transform .2s}
.p-swiper input{position:absolute;opacity:0;pointer-events:none}
.p-swiper input:checked+.p-swiper-track{background:hsl(var(--primary))}
.p-swiper input:checked+.p-swiper-track::after{transform:translateX(16px)}

/* Progress */
.p-progress{width:100%;height:8px;border-radius:99px;background:hsl(var(--secondary));overflow:hidden}
.p-progress__bar{height:100%;border-radius:99px;background:hsl(var(--primary));transition:width .3s;min-width:4px}
.p-progress__bar--indeterminate{width:30%!important;animation:p-spin 1.5s ease-in-out infinite}
@keyframes p-spin{0%{transform:translateX(-100%)}100%{transform:translateX(400%)}}
.p-progress__bar--danger{background:hsl(var(--destructive))}
.p-progress__bar--warn{background:#f59e0b}

/* Loader / Spinner */
.p-loader{display:inline-block;width:20px;height:20px;border:2px solid hsl(var(--border));border-top-color:hsl(var(--primary));border-radius:50%;animation:p-spinner .6s linear infinite}
@keyframes p-spinner{to{transform:rotate(360deg)}}

/* Empty state */
.p-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px;color:hsl(var(--muted-foreground));gap:8px}
.p-empty__icon{font-size:32px;line-height:1}
.p-empty__text{font-size:13px}

/* Alert */
.p-alert{padding:10px 14px;border-radius:0.375rem;font-size:13px;color:hsl(var(--foreground));line-height:1.5;border:1px solid}
.p-alert--info{background:rgba(96,165,250,.1);border-color:rgba(96,165,250,.2)}
.p-alert--success{background:hsl(var(--primary) / 0.1);border-color:hsl(var(--primary) / 0.2)}
.p-alert--warn{background:rgba(245,158,11,.1);border-color:rgba(245,158,11,.2)}
.p-alert--error{background:hsl(var(--destructive) / 0.1);border-color:hsl(var(--destructive) / 0.2)}

/* Table */
.p-table{width:100%;font-size:13px;border-collapse:collapse}
.p-table th{padding:8px 12px;text-align:left;font-weight:600;color:hsl(var(--muted-foreground));border-bottom:1px solid hsl(var(--border));font-size:12px}
.p-table td{padding:8px 12px;border-bottom:1px solid hsl(var(--border) / 0.5);color:hsl(var(--foreground))}
.p-table tr:hover td{background:hsl(var(--muted))}

/* Tooltip */
.p-tooltip{position:relative}
.p-tooltip[data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:hsl(var(--card));color:hsl(var(--card-foreground));font-size:11px;padding:4px 8px;border-radius:0.25rem;white-space:nowrap;pointer-events:none;z-index:10;margin-bottom:4px;border:1px solid hsl(var(--border));box-shadow:0 4px 12px rgba(0,0,0,.4)}

/* Color picker */
.p-color-picker{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid hsl(var(--border));border-radius:0.375rem;background:hsl(var(--background));cursor:pointer;font-size:13px;color:hsl(var(--foreground))}
.p-color-picker__swatch{width:18px;height:18px;border-radius:0.25rem;border:1px solid hsl(var(--border));flex-shrink:0}

/* Menu */
.p-menu{background:hsl(var(--card));border:1px solid hsl(var(--border));border-radius:0.5rem;padding:4px;min-width:140px;box-shadow:0 4px 16px rgba(0,0,0,.4)}
.p-menu-item{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:0.25rem;font-size:13px;color:hsl(var(--foreground));cursor:pointer;transition:background .1s}
.p-menu-item:hover{background:hsl(var(--muted))}
.p-menu-item--danger{color:hsl(var(--destructive))}
.p-menu-item--danger:hover{background:hsl(var(--destructive) / 0.12)}

/* Select */
.p-select{position:relative}
.p-select select{appearance:none;width:100%;background:hsl(var(--background));border:1px solid hsl(var(--border));border-radius:0.375rem;padding:6px 30px 6px 10px;color:hsl(var(--foreground));font-size:13px;cursor:pointer;outline:none;height:32px}
.p-select select:focus{border-color:hsl(var(--ring));box-shadow:0 0 0 1px hsl(var(--ring) / 0.2)}
.p-select::after{content:'';position:absolute;right:10px;top:50%;transform:translateY(-50%);width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid hsl(var(--muted-foreground));pointer-events:none}

/* Layout */
.p-row{display:flex;gap:8px;align-items:center}
.p-row--wrap{flex-wrap:wrap}
.p-col{display:flex;flex-direction:column;gap:8px}
.p-row--between{justify-content:space-between}

.p-icon{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center}
.p-icon--lg{width:24px;height:24px;font-size:18px}

/* Utility */
.p-ml-auto{margin-left:auto}
.p-mt-1{margin-top:4px}.p-mt-2{margin-top:8px}.p-mt-3{margin-top:12px}
.p-mb-1{margin-bottom:4px}.p-mb-2{margin-bottom:8px}.p-mb-3{margin-bottom:12px}
.p-gap-1{gap:4px}.p-gap-2{gap:8px}.p-gap-3{gap:12px}
.p-text-center{text-align:center}
.p-text-muted{color:hsl(var(--muted-foreground))}
.p-text-sm{font-size:12px}
.p-text-xs{font-size:11px}
.p-text-lg{font-size:16px}
.p-font-mono{font-family:monospace}
.p-truncate{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.p-rounded{border-radius:0.375rem}
`

export const injectCss = `<style>${pluginCss}<\/style>`

export const THEME_KEYS = [
  'background', 'foreground', 'card', 'card-foreground', 'popover', 'popover-foreground',
  'primary', 'primary-foreground', 'secondary', 'secondary-foreground',
  'muted', 'muted-foreground', 'accent', 'accent-foreground',
  'destructive', 'destructive-foreground', 'border', 'input', 'ring',
] as const

export function getThemeVars(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const vars: Record<string, string> = {}
  for (const k of THEME_KEYS) vars[k] = cs.getPropertyValue(`--${k}`).trim()
  return vars
}

export function getThemeScheme(): string {
  return document.documentElement.classList.contains('light') ? 'light' : 'dark'
}

export function getThemeVarsCss(): string {
  const vars = getThemeVars()
  const pairs = THEME_KEYS.map(k => `--${k}:${vars[k]}`).join(';')
  return `:root{color-scheme:${getThemeScheme()};${pairs}}body{background:hsl(var(--background))}`
}

export const themeBridgeScript = `<script>
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === '__qomicex_theme') {
    var root = document.documentElement
    var vars = e.data.vars || {}
    for (var k in vars) { root.style.setProperty('--' + k, vars[k]) }
    root.style.colorScheme = e.data.scheme
  }
})
<\/script>`

const themeSyncTargets = new Set<HTMLIFrameElement>()
let themeObserver: MutationObserver | null = null

export function registerThemeSync(iframe: HTMLIFrameElement) {
  themeSyncTargets.add(iframe)
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      const vars = getThemeVars()
      const scheme = getThemeScheme()
      themeSyncTargets.forEach(f => {
        try { f.contentWindow?.postMessage({ type: '__qomicex_theme', vars, scheme }, '*') } catch { }
      })
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
  return () => {
    themeSyncTargets.delete(iframe)
    if (themeSyncTargets.size === 0 && themeObserver) {
      themeObserver.disconnect()
      themeObserver = null
    }
  }
}
