// lint 增强静态检查：相对 import 缺扩展名 + entry/contributes 引用文件存在性，
// 复用 verify 的 manifest / 权限最小化 / 长循环检查（更严的发布前静态门禁）。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { ManifestIssue } from './manifest.ts'
import { collectSourceFiles, type ScanFinding } from './scan.ts'

export type LintFinding = ScanFinding | ManifestIssue

const TS_SRC_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const REL_IMPORT_RE = /\bfrom\s*['"](\.\.?\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]/g

function isDirBarrel(imp: string, file: string): boolean {
  const base = resolve(dirname(file), imp)
  if (!existsSync(base)) return false
  for (const idx of ['index.ts', 'index.tsx', 'index.js', 'index.mjs']) {
    if (existsSync(join(base, idx))) return true
  }
  return false
}

/** 检查相对 import 是否带扩展名（Vite 硬规则；目录 barrel 如 ./components/ui 豁免）。 */
export function checkImportExtensions(root: string): ScanFinding[] {
  const findings: ScanFinding[] = []
  for (const file of collectSourceFiles(root)) {
    if (!TS_SRC_EXTS.test(file)) continue
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const m of content.matchAll(REL_IMPORT_RE)) {
      const imp = m[1] ?? m[2]
      if (!imp || /\.\w+$/.test(imp)) continue
      if (isDirBarrel(imp, file)) continue
      findings.push({
        severity: 'error',
        message: `相对导入缺少文件扩展名: ${imp}（Vite 硬规则，请补 .ts/.tsx/.css 等）`,
        file: `${relative(root, file)}`,
      })
    }
  }
  return findings
}

/** 检查 manifest 引用的资源文件是否存在（dist/ 引用未构建时给 warning，src/ 引用缺失给 error）。 */
export function checkRefFiles(root: string, manifest: Record<string, unknown>): ScanFinding[] {
  const findings: ScanFinding[] = []
  const entry = manifest.entry as Record<string, unknown> | undefined
  const overlay = (manifest.contributes as { overlay?: { file?: string } } | undefined)?.overlay
  const slots = (manifest.contributes as { slots?: Array<{ file?: string }> } | undefined)?.slots
  const refs: Array<[string, string]> = []
  if (entry) {
    for (const key of ['frontend', 'theme', 'backend']) {
      const v = entry[key]
      if (typeof v === 'string') refs.push([`entry.${key}`, v])
    }
  }
  if (overlay && typeof overlay.file === 'string') refs.push(['contributes.overlay.file', overlay.file])
  for (const s of slots ?? []) {
    if (typeof s.file === 'string') refs.push(['contributes.slots[].file', s.file])
  }

  for (const [where, ref] of refs) {
    if (!ref.startsWith('dist/') && !ref.startsWith('src/')) continue
    if (existsSync(join(root, ref))) continue
    if (ref.startsWith('dist/')) {
      const srcPath = join(root, ref.slice('dist/'.length))
      if (existsSync(srcPath)) continue
      findings.push({
        severity: 'warning',
        message: `${where} 引用的 ${ref} 不存在（尚未构建；qomicex pack 会先 tsc+vite build）`,
        file: ref,
      })
    } else {
      findings.push({ severity: 'error', message: `${where} 引用的文件不存在: ${ref}`, file: ref })
    }
  }
  return findings
}