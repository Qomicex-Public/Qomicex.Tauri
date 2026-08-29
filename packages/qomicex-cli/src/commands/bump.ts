// qomicex bump — 递增 manifest.json 版本号（major/minor/patch）。
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readManifestFile } from '../lib/project.ts'
import { fail, info } from '../lib/io.ts'

export interface BumpOptions {
  part: string
  version?: string
}

// 与 manifest.ts SEMVER_RE 保持一致：支持 pre-release 与 build metadata（+xxx）。
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export async function bumpCommand(opts: BumpOptions): Promise<string> {
  const manifestFile = join(process.cwd(), 'manifest.json')
  if (!existsSync(manifestFile)) fail('当前目录不是插件项目（缺少 manifest.json）')

  const manifest = readManifestFile(manifestFile)
  const current = String(manifest.version ?? '')
  const next =
    opts.version ?? (() => {
      const m = SEMVER_RE.exec(current)
      if (!m) fail(`当前版本不是合法 semver: ${current}`)
      const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
      if (opts.part === 'major') return `${major + 1}.0.0`
      if (opts.part === 'patch') return `${major}.${minor}.${patch + 1}`
      return `${major}.${minor + 1}.0`
    })()

  if (!SEMVER_RE.test(next)) fail(`目标版本不是合法 semver: ${next}`)

  manifest.version = next
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  info(`✔ manifest.json version: ${current} → ${next}`)
  return next
}
