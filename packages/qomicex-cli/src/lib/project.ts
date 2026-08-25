// 插件项目本地操作：manifest 读取 / dist 收集。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export function readManifestFile(file: string): Record<string, unknown> {
  const text = readFileSync(file, 'utf8')
  return JSON.parse(text) as Record<string, unknown>
}

/** 收集目录下全部文件为 zip 条目（prefix 为包内前缀，路径用 /）。 */
export function collectDir(root: string, prefix: string): { name: string; data: Uint8Array }[] {
  const out: { name: string; data: Uint8Array }[] = []
  const walk = (dir: string) => {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const p = join(dir, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p)
      else out.push({ name: `${prefix}${relative(root, p).split('\\').join('/')}`, data: readFileSync(p) })
    }
  }
  walk(root)
  return out
}

export function assertProjectRoot(cwd: string): string {
  if (cwd === '' || cwd === undefined) return ''
  return cwd
}
