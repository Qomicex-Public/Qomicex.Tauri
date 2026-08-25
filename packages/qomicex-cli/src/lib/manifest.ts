// manifest.json 校验（手写极简 schema，等价于 zod 子集，零依赖）。
// 字段蓝本：src/plugins/types.ts + store 上传校验（checkQplugin）。
import { PERMISSION_CATALOG } from './permissions.ts'

export const ID_RE = /^(?!.*\.\.)[a-z0-9]+([.-][a-z0-9]+)*$/
export const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
export const LAYERS = ['l0', 'l1', 'l2', 'l3']

export interface ManifestIssue {
  severity: 'error' | 'warning'
  path: string
  message: string
}

export interface ManifestCheck {
  ok: boolean
  issues: ManifestIssue[]
}

export function checkId(id: unknown): string[] {
  const errs: string[] = []
  if (typeof id !== 'string') return ['id 必须是字符串']
  if (id.length < 3 || id.length > 128) errs.push('id 长度必须在 3-128 之间')
  if (!ID_RE.test(id)) errs.push('id 必须是反向域名格式（小写字母/数字/点/连字符，禁止连续双点，如 com.example.demo）')
  if (!id.includes('.')) errs.push('id 建议使用反向域名格式（含至少一个点），当前形如 hello-plugin')
  return errs
}

export function validateManifest(raw: unknown): ManifestCheck {
  const issues: ManifestIssue[] = []
  const add = (severity: 'error' | 'warning', path: string, message: string) =>
    issues.push({ severity, path, message })

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ severity: 'error', path: 'manifest', message: 'manifest 必须是 JSON 对象' }] }
  }
  const m = raw as Record<string, unknown>

  for (const err of checkId(m.id)) add(err.startsWith('id 建议') ? 'warning' : 'error', 'id', err)

  if (typeof m.name !== 'string' || !m.name.trim()) add('error', 'name', '缺少必填字段 name')
  if (typeof m.version !== 'string') {
    add('error', 'version', '缺少必填字段 version')
  } else if (!SEMVER_RE.test(m.version)) {
    add('error', 'version', `version 不是合法 semver: ${m.version}`)
  }
  if (typeof m.minLauncherVersion !== 'string') add('error', 'minLauncherVersion', '缺少必填字段 minLauncherVersion')

  if (!Array.isArray(m.layers) || m.layers.length === 0) {
    add('error', 'layers', 'layers 必须是数组且至少一项')
  } else {
    for (const l of m.layers) {
      if (!LAYERS.includes(l as string)) add('error', 'layers', `未知 layer: ${String(l)}（可用 ${LAYERS.join('/')}）`)
    }
    const hasFrontend = !!(m.entry as Record<string, unknown> | undefined)?.frontend
    if (!m.layers.includes('l2') && !m.layers.includes('l3') && hasFrontend) {
      add('warning', 'layers', '声明了 frontend 入口但 layers 无 l2/l3，将无法渲染 UI')
    }
    if (!m.layers.includes('l2') && hasFrontend) {
      add('warning', 'layers', 'UI 插件建议声明 l2（iframe 沙箱）')
    }
  }

  if (!Array.isArray(m.permissions)) {
    add('error', 'permissions', 'permissions 必须是数组')
  } else {
    for (const p of m.permissions) {
      if (!PERMISSION_CATALOG[(p as string)]) {
        add('warning', 'permissions', `未知权限: ${String(p)}（启动器可能不认识）`)
      }
    }
  }

  const entry = m.entry
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    add('error', 'entry', '缺少必填字段 entry（至少 frontend/backend/theme 之一）')
  } else {
    const e = entry as Record<string, unknown>
    if (!e.frontend && !e.backend && !e.theme) {
      add('error', 'entry', 'entry 至少需要 frontend/backend/theme 之一')
    }
    if (typeof e.frontend === 'string' && !e.frontend.endsWith('.html')) {
      add('warning', 'entry.frontend', 'frontend 应指向 .html（如 dist/index.html）')
    }
  }

  if (m.dependencies !== undefined && !Array.isArray(m.dependencies)) add('error', 'dependencies', 'dependencies 必须是数组')
  if (m.render !== undefined && m.render !== 'inline' && m.render !== 'iframe') {
    add('warning', 'render', "render 仅支持 'inline' / 'iframe'")
  }

  if (m.contributes !== undefined) {
    const c = m.contributes as Record<string, unknown>
    if (c.menuItems !== undefined && !Array.isArray(c.menuItems)) add('error', 'contributes.menuItems', 'menuItems 必须是数组')
    if (c.overlay !== undefined) {
      const o = c.overlay as Record<string, unknown>
      if (typeof o.file !== 'string') add('error', 'contributes.overlay.file', 'overlay.file 必须指定 .html 文件')
    }
  }

  return { ok: issues.every((i) => i.severity !== 'error'), issues }
}
