// qomicex lint — 增强静态检查（比 verify 更严的发布前门禁）：manifest 合法性 +
// 权限最小化 + 长循环告警 + 相对 import 扩展名 + 资源引用存在性。支持 --json 供 CI。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateManifest } from '../lib/manifest.ts'
import { checkImportExtensions, checkRefFiles, type LintFinding } from '../lib/lint.ts'
import { checkLongLoops, checkPermissions } from '../lib/scan.ts'
import { fail, info } from '../lib/io.ts'

export interface LintOptions {
  json?: boolean
}

export async function lintCommand(opts: LintOptions = {}): Promise<void> {
  const root = process.cwd()
  const manifestFile = join(root, 'manifest.json')
  if (!existsSync(manifestFile)) fail('当前目录不是插件项目（缺少 manifest.json）')

  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
  const findings: LintFinding[] = []
  let errors = 0

  const mCheck = validateManifest(manifest)
  findings.push(...mCheck.issues)
  errors += mCheck.issues.filter((i) => i.severity === 'error').length

  const permissions = Array.isArray(manifest.permissions) ? (manifest.permissions as string[]) : []
  const permCheck = checkPermissions(root, permissions)
  findings.push(...permCheck.findings)
  errors += permCheck.findings.filter((f) => f.severity === 'error').length

  findings.push(...checkLongLoops(root))

  const imports = checkImportExtensions(root)
  findings.push(...imports)
  errors += imports.filter((f) => f.severity === 'error').length

  const refs = checkRefFiles(root, manifest)
  findings.push(...refs)
  errors += refs.filter((f) => f.severity === 'error').length

  const warnings = findings.length - errors

  if (opts.json) {
    console.log(JSON.stringify({ ok: errors === 0, errors, warnings, findings }, null, 2))
  } else {
    for (const f of findings) {
      const tag = f.severity === 'error' ? '✗' : '⚠'
      const loc = 'file' in f && f.file ? ` (${f.file})` : ''
      if (f.severity === 'error') console.error(`${tag} ${f.message}${loc}`)
      else console.warn(`${tag} ${f.message}${loc}`)
    }
    info(`\nlint 完成：${errors} 错误 / ${warnings} 警告（manifest ${mCheck.issues.length} 项、权限 ${permissions.length} 项）`)
    if (errors > 0) {
      console.error('发现错误，请修复后重试')
      process.exit(1)
    }
    info('✔ lint 通过')
  }

  if (errors > 0) process.exit(1)
}