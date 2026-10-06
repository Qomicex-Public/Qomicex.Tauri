#!/usr/bin/env node
// 护栏：下载中心渲染的「后端标识」必须在 i18n 里有词条，否则界面直接显示键名。
//
// 查两类：
//   1. steps —— 后端安装管线步骤 id，前端 `t('downloads.steps.${id}')`
//      （src/components/InstallStepsList.tsx + src/pages/DownloadCenter.tsx 的 dominantStep 文案）；
//   2. stage —— DownloadCenter 的 `STAGE_LABELS` 白名单，前端 `t('downloads.stage.${stage}')`。
//
// 为什么需要它：t() 查不到键时**原样返回键名**（src/i18n/index.tsx:60）→ 卡片上直接显示
// `downloads.steps.jarmod` / `downloads.stage.modpack-update-finalize`。新增管线步骤（Technic
// Solder 期3 就漏了 download-mods / verify / extract-merge / jarmod）或往白名单加 stage 时
// 不会有任何报错，只是静默显示键名 —— 本脚本把这件事变成硬门禁。
//
// 数据来源（都不需要编译或运行后端）：
//   A) src-backend/qomicex-backend/src/**/*.rs
//      - `InstallStepSpec { id: "..." }` / 别名（`use InstallStepSpec as S`）里的字面量 id；
//      - 间接 id（`id: step_id`）在同一文件内回溯 `let step_id = "..."` 解析；
//      - `mark_step("...")` / `set_step_percent("...")` 的字面量首参（兜底覆盖未进 define_steps 的步骤）。
//      - `set_stage("...")` / `x.stage = "..."` 字面量（仅用于提示后端有、白名单没有的 stage）。
//   B) src/pages/DownloadCenter.tsx 的 STAGE_LABELS 键。
//   C) qomicex-tauri-i18n/src/<lang>/downloads.ts 的 `steps` / `stage` 块键名。
// 逐语言比对，任何标识在任一语言里缺词条即 FAIL（退出码 1）。
//
// 用法：pnpm run test:i18n-steps

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BACKEND_SRC = join(ROOT, 'src-backend', 'qomicex-backend', 'src')
const I18N_DIR = join(ROOT, 'qomicex-tauri-i18n', 'src')
const DOWNLOAD_CENTER = join(ROOT, 'src', 'pages', 'DownloadCenter.tsx')
const LANGS = ['zh-CN', 'zh-TW', 'zh-HK', 'en-US', 'en-GB', 'ja-JP', 'ru-RU']
const DEFAULT_SPEC_TYPES = ['InstallStepSpec', 'S']

if (!existsSync(I18N_DIR)) {
  console.error(
    `[test-i18n-step-keys] i18n 子模块未初始化：${relative(ROOT, I18N_DIR)}\n` +
      '  先跑 `git submodule update --init qomicex-tauri-i18n`。',
  )
  process.exit(1)
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

function walkRustFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkRustFiles(full))
    else if (entry.name.endsWith('.rs')) out.push(full)
  }
  return out
}

/**
 * 抹掉 `#[cfg(test)]` 标注的模块/函数体（占位为空格，保持行号不变）。
 * 单测里也有 `mark_step("a"/"b")` 这类假 id；而测试模块可能出现在文件中部
 * （如 modpack.rs 的 solder_tests），所以不能简单地「截断到第一个 #[cfg(test)]」。
 */
function stripCfgTestBlocks(text) {
  const marker = '#[cfg(test)]'
  const shape = /^\s*(?:#\[[^\]]*\]\s*|pub(?:\([^)]*\))?\s*)*(?:mod\s+\w+|(?:async\s+)?fn\s+\w+)/
  let out = ''
  let cursor = 0
  for (;;) {
    const at = text.indexOf(marker, cursor)
    if (at < 0) {
      out += text.slice(cursor)
      return out
    }
    out += text.slice(cursor, at)
    const open = text.indexOf('{', at)
    if (open < 0 || !shape.test(text.slice(at + marker.length, open))) {
      // 形态不符（如 `#[cfg(test)] use ...;`）：保守保留，不删除
      out += marker
      cursor = at + marker.length
      continue
    }
    let depth = 0
    let end = open
    for (; end < text.length; end += 1) {
      if (text[end] === '{') depth += 1
      else if (text[end] === '}') {
        depth -= 1
        if (depth === 0) {
          end += 1
          break
        }
      }
    }
    out += text.slice(at, end).replace(/[^\n]/g, ' ')
    cursor = end
  }
}

/** 逐文件扫后端源码（生产代码），把命中交给 `visit(text, rel)`。 */
function eachBackendSource(visit) {
  for (const file of walkRustFiles(BACKEND_SRC)) {
    visit(stripCfgTestBlocks(readFileSync(file, 'utf8')), relative(ROOT, file))
  }
}

/** 后端安装管线定义的 step id（`id` → ['file:line', ...]）+ 无法解析的间接 id。 */
function collectBackendStepIds() {
  /** @type {Map<string, string[]>} */
  const ids = new Map()
  /** @type {string[]} */
  const unresolved = []
  const add = (id, where) => {
    if (!ids.has(id)) ids.set(id, [])
    ids.get(id).push(where)
  }

  eachBackendSource((text, rel) => {
    // `use crate::services::install_tracker::InstallStepSpec as S;` 之类的别名
    const specTypes = new Set(DEFAULT_SPEC_TYPES)
    for (const m of text.matchAll(/use\s+[\w:]*InstallStepSpec\s+as\s+([A-Za-z_]\w*)/g)) {
      specTypes.add(m[1])
    }
    const specRe = new RegExp(`\\b(?:${[...specTypes].join('|')})\\s*\\{([^{}]*)\\}`, 'gs')
    for (const m of text.matchAll(specRe)) {
      const idMatch = /\bid:\s*(?:"([^"]+)"|([A-Za-z_]\w*))/.exec(m[1])
      if (!idMatch) continue
      const where = `${rel}:${lineOf(text, m.index)}`
      if (idMatch[1]) {
        add(idMatch[1], where)
        continue
      }
      // 间接 id：回溯同文件内的 `let step_id = "..."` / `const step_id: &str = "..."`
      const ident = idMatch[2]
      const assign = new RegExp(`(?:let|const)\\s+${ident}\\s*(?::[^=]*)?=\\s*"([^"]+)"`).exec(text)
      if (assign) add(assign[1], where)
      else
        unresolved.push(`${where}: 无法解析间接 step id \`${ident}\`（未找到同文件内的字符串赋值）`)
    }
    for (const m of text.matchAll(/(?:mark_step|set_step_percent)\(\s*"([^"]+)"/g)) {
      add(m[1], `${rel}:${lineOf(text, m.index)}`)
    }
  })
  return { ids, unresolved }
}

/** 后端实际下发过的 stage 字面量（仅作提示：白名单里没有时会退化成通用文案）。 */
function collectBackendStages() {
  const stages = new Map()
  eachBackendSource((text, rel) => {
    for (const m of text.matchAll(/(?:set_stage\(|\.stage\s*=\s*)"([^"]+)"/g)) {
      if (!stages.has(m[1])) stages.set(m[1], [])
      stages.get(m[1]).push(`${rel}:${lineOf(text, m.index)}`)
    }
  })
  return stages
}

/** DownloadCenter.tsx 的 STAGE_LABELS 白名单（会走 t('downloads.stage.*') 的那批）。 */
function collectStageWhitelist() {
  const text = readFileSync(DOWNLOAD_CENTER, 'utf8')
  const block = /^const STAGE_LABELS[^=]*= \{\r?\n([\s\S]*?)^\}/m.exec(text)
  if (!block) return null
  const rel = relative(ROOT, DOWNLOAD_CENTER)
  const base = lineOf(text, block.index)
  const stages = new Map()
  for (const m of block[1].matchAll(/^\s{2}'([^']+)'|^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)) {
    const key = m[1] ?? m[2]
    // 块内行号 = 块起始行 + 该行在本块内的偏移
    const offset = lineOf(block[1], m.index)
    stages.set(key, [`${rel}:${base + offset}`])
  }
  return stages
}

/** 读取某语言 downloads.ts 里 `steps` / `stage` 块的键名。 */
function collectI18nBlockKeys(lang, blockName) {
  const file = join(I18N_DIR, lang, 'downloads.ts')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const re = new RegExp(`^ {2}${blockName}: \\{\\r?\\n([\\s\\S]*?)^ {2}\\},`, 'm')
  const block = re.exec(text)
  if (!block) return null
  const keys = new Set()
  for (const m of block[1].matchAll(/^ {4}(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:/gm)) {
    keys.add(m[1] ?? m[2])
  }
  return keys
}

let failed = false

/**
 * 逐语言比对一组「后端/前端标识 ↔ i18n 词条」。
 * @returns {{ missingByLang: Map<string, string[]>, requiredCount: number, parsedLangs: number }}
 */
function checkCoverage(label, i18nBlock, required) {
  const sorted = [...required.keys()].sort()
  console.log(`\n[test-i18n-step-keys] ${label}：${sorted.length} 个标识 —— ${sorted.join(', ')}`)
  const missingByLang = new Map()
  let parsedLangs = 0
  for (const lang of LANGS) {
    const keys = collectI18nBlockKeys(lang, i18nBlock)
    if (!keys) {
      failed = true
      console.error(
        `  ✗ ${lang}: 无法解析 qomicex-tauri-i18n/src/${lang}/downloads.ts 的 ${i18nBlock} 块`,
      )
      continue
    }
    parsedLangs += 1
    const missing = sorted.filter((id) => !keys.has(id))
    if (missing.length > 0) {
      failed = true
      missingByLang.set(lang, missing)
      console.error(`  ✗ ${lang}: 缺 ${missing.length} 个 —— ${missing.join(', ')}`)
    } else {
      console.log(`  ✓ ${lang}: ${keys.size} 个词条，覆盖全部 ${sorted.length} 个标识`)
    }
  }
  if (missingByLang.size > 0) {
    console.error(
      `  给 downloads.${i18nBlock} 补词条（7 语言都要补，zh-CN 是 TranslationSchema 基准）；标识来源：`,
    )
    for (const [lang, missing] of missingByLang) {
      for (const id of missing) {
        console.error(`    ${lang} · ${id} ← ${(required.get(id) ?? []).join(', ') || '(未知)'}`)
      }
    }
  }
  return { missingByLang, requiredCount: sorted.length, parsedLangs }
}

const { ids: stepIds, unresolved } = collectBackendStepIds()

if (unresolved.length > 0) {
  failed = true
  console.error('[test-i18n-step-keys] 后端 step id 解析失败：')
  for (const u of unresolved) console.error(`  ✗ ${u}`)
}

const stageWhitelist = collectStageWhitelist()
if (!stageWhitelist) {
  failed = true
  console.error(`[test-i18n-step-keys] 无法解析 ${relative(ROOT, DOWNLOAD_CENTER)} 的 STAGE_LABELS`)
}

const stepResult = checkCoverage('后端安装管线 step id → downloads.steps', 'steps', stepIds)
const stageResult = stageWhitelist
  ? checkCoverage('DownloadCenter STAGE_LABELS → downloads.stage', 'stage', stageWhitelist)
  : { missingByLang: new Map(), requiredCount: 0, parsedLangs: 0 }

// 反向信息（不判失败 1）：steps 词条存在但本仓后端不产生，多为下载库子模块下发的步骤。
const knownSteps = new Set(stepIds.keys())
for (const lang of LANGS) {
  const keys = collectI18nBlockKeys(lang, 'steps')
  if (!keys) continue
  const orphans = [...keys].filter((k) => !knownSteps.has(k))
  if (orphans.length > 0) {
    console.log(
      `[提示] ${lang} 的 steps 里 ${orphans.sort().join(', ')} 后端本仓当前不产生（多由下载库子模块下发，无需处理）`,
    )
  }
}

// 反向信息（不判失败 2）：后端下发但白名单没登记的 stage → 卡片退化成通用「下载中」文案。
if (stageWhitelist) {
  const notWhitelisted = [...collectBackendStages().keys()].filter((s) => !stageWhitelist.has(s))
  if (notWhitelisted.length > 0) {
    console.log(
      `[提示] 后端下发但 STAGE_LABELS 未登记（显示通用「下载中」，不显示键名）：${notWhitelisted.sort().join(', ')}`,
    )
  }
}

if (failed) {
  console.error('\n[test-i18n-step-keys] FAILED')
  process.exit(1)
}

console.log(
  `\n[test-i18n-step-keys] OK —— ${stepResult.parsedLangs} 种语言覆盖 ${stepResult.requiredCount} 个 step id` +
    ` + ${stageResult.requiredCount} 个 stage（${stageResult.parsedLangs} 种语言）。`,
)
