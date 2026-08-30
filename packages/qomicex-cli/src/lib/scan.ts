// verify 的静态启发式扫描：权限最小化 + 主线程长循环告警。
// 均为轻量文本/正则，不做真 AST（提案允许"简单启发式即可"）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { METHOD_PERMISSIONS } from './permissions.ts'

export interface ScanFinding {
  severity: 'error' | 'warning'
  message: string
  file?: string
}

const SRC_EXTS = /\.(ts|tsx|js|jsx|mjs|cjs|html)$/

/**
 * 递归收集插件源码文件（跳过 node_modules/release/.staging）。
 * dist/ 的跳过规则：项目有 src/ 目录时，dist 视为构建产物跳过；
 * 无 src/ 的纯静态/纯 html 插件（源码直接放 dist 或根目录）则扫描 dist。
 */
export function collectSourceFiles(root: string, maxFiles = 400): string[] {
  const out: string[] = []
  const hasSrc = existsSync(join(root, 'src'))
  const skipDists = hasSrc
  const walk = (dir: string) => {
    if (out.length >= maxFiles) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === 'release' || name.startsWith('.staging')) continue
      if (name === 'dist' && skipDists) continue
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isDirectory()) walk(p)
        else if (st.size < 1_000_000 && SRC_EXTS.test(name)) out.push(p)
      } catch {
        /* ignore unreadable */
      }
    }
  }
  walk(root)
  return out
}

/** 提取源码里用到的桥方法名（.call('x') 与 __PLUGIN_API__.x / __PLUGIN_API__?.x 两种形态）。 */
function usedMethods(content: string): Set<string> {
  const found = new Set<string>()
  const callRe = /\.call\(\s*['"]([a-zA-Z0-9_.]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = callRe.exec(content)) !== null) found.add(m[1]!)
  const directRe = /__PLUGIN_API__\??\.([a-zA-Z0-9_]+)\(/g
  while ((m = directRe.exec(content)) !== null) {
    const name = m[1]!
    if (name in METHOD_PERMISSIONS) found.add(name)
  }
  const dottedRe = /__PLUGIN_API__\??\.(download|overlay|modpack)\.([a-zA-Z0-9_]+)\(/g
  while ((m = dottedRe.exec(content)) !== null) found.add(`${m[1]}.${m[2]}`)
  return found
}

export interface PermCheck {
  findings: ScanFinding[]
  /** 声明了但源码里没找到用法 */
  unused: string[]
  /** 用了但未声明（运行时会被拒） */
  missing: string[]
}

/** L3 纯 wasm 插件：layers 含 l3 且无前端 entry（无 l2/l4、无 entry.frontend），
 * 或项目存在 Cargo.toml（Rust wasm 项目）。此类无 JS 源码，跳过 JS 权限扫描。 */
export function isWasmOnlyPlugin(root: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
      layers?: string[]
      entry?: { frontend?: unknown }
    }
    const layers = manifest.layers ?? []
    const hasFrontendEntry = !!(manifest.entry as { frontend?: unknown } | undefined)?.frontend
    if (layers.includes('l2') || layers.includes('l4') || hasFrontendEntry) return false
    return layers.includes('l3') || existsSync(join(root, 'Cargo.toml'))
  } catch {
    return false
  }
}

export function checkPermissions(root: string, declared: string[]): PermCheck {
  const findings: ScanFinding[] = []
  // L3 纯 wasm 插件无 JS 源码，wasm:execute 权限由网关消费，不参与 JS 权限最小化扫描
  if (isWasmOnlyPlugin(root)) {
    return { findings, unused: [], missing: [] }
  }
  const used = new Set<string>()
  for (const file of collectSourceFiles(root)) {
    try {
      for (const method of usedMethods(readFileSync(file, 'utf8'))) used.add(method)
    } catch {
      /* skip */
    }
  }
  const required = new Set<string>()
  for (const method of used) {
    const perm = METHOD_PERMISSIONS[method]
    if (perm) required.add(perm)
  }
  const missing = [...required].filter((p) => !declared.includes(p))
  const unused = declared.filter((p) => !required.has(p))

  for (const p of missing) {
    findings.push({ severity: 'error', message: `源码调用了桥方法，但未声明所需权限 ${p}（运行时会被启动器拒绝）` })
  }
  for (const p of unused) {
    findings.push({ severity: 'error', message: `声明了权限 ${p} 但源码未使用（最小权限原则，建议移除）` })
  }
  return { findings, unused, missing }
}

/** 长循环 / 无界定时器启发式：命中即告警（不阻断），提示放到 Worker/WASM/后端。 */
export function checkLongLoops(root: string): ScanFinding[] {
  const findings: ScanFinding[] = []
  const patterns: Array<[RegExp, string]> = [
    [/while\s*\(\s*(?:true|1)\s*\)/, '检测到 while(true) 同步死循环，会冻结整个启动器主线程（即使在内联/iframe 内）'],
    [/for\s*\(\s*;\s*;\s*\)/, '检测到 for(;;) 无退出条件同步死循环'],
    [/setInterval\s*\(/, '检测到 setInterval 高频轮询；请确保有 clearInterval 且间隔合理（默认建议 ≥500ms）'],
  ]
  for (const file of collectSourceFiles(root)) {
    const content = readFileSync(file, 'utf8')
    for (const [re, msg] of patterns) {
      const m = re.exec(content)
      if (m) {
        const lineNo = content.slice(0, m.index).split('\n').length
        findings.push({ severity: 'warning', message: msg, file: `${relative(root, file)}:${lineNo}` })
      }
    }
  }
  return findings
}
