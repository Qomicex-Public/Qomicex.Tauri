#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later
//
// 为仓库源文件写入统一版权头（issue #248）。
//
// 头部格式（用户确认）：
//   Copyright (C) 2026 Qomicex Launcher Contributors
//   SPDX-License-Identifier: GPL-3.0-or-later
//
// 设计要点：
// - **按字节处理**，保留每个文件原有的行尾（仓库 .gitattributes 声明 `* text=auto`，
//   工作区存在 CRLF 与 LF 混用；统一改写行尾会产生全文件 EOL churn）。
// - **shebang 之后插入**：scripts/*.mjs 与 CLI 入口以 `#!` 开头，注释不能跑到它前面，
//   否则破坏可执行性。
// - **triple-slash 之前插入**：`/// <reference />` 允许位于注释之后（已用 tsc 实测），
//   放在文件最前是惯例，故头仍在最前。
// - **幂等**：已含 SPDX 标记的文件跳过，可反复运行。
//
// 例外（不写入，见 issue #248 的范围决策）：
// - packages/qomicex-cli/templates/：会被 `qomicex create` 原样复制成**用户自己的**
//   插件项目（package.json 为 private、无 license）。给它加本项目版权头会造成授权误归属。
// - plugins-dev/：同类示例插件骨架。
//
// 用法：node scripts/add-license-headers.mjs [--check]
//   --check：只报告缺失，不写文件（CI 校验用）。

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extname } from 'node:path'

const COPYRIGHT = 'Copyright (C) 2026 Qomicex Launcher Contributors'
const SPDX = 'SPDX-License-Identifier: GPL-3.0-or-later'

/** 纳入范围的语言（按扩展名选注释语法）。 */
const COMMENT_STYLE = {
  '.rs': 'line',
  '.ts': 'line',
  '.tsx': 'line',
  '.js': 'line',
  '.mjs': 'line',
  '.css': 'block',
}

/** 不写入的项目相对路径前缀（原因见文件头注释）。 */
const EXCLUDED_PREFIXES = ['packages/qomicex-cli/templates/', 'plugins-dev/']

/** 用 git ls-files 取**仓库跟踪**的文件，天然排除 node_modules / dist / target。 */
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  return out.split('\0').filter(Boolean)
}

function inScope(rel) {
  if (!(extname(rel) in COMMENT_STYLE)) return false
  if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) return false
  return true
}

/** 构造头部文本块（以文件自身的行尾结尾）。 */
function buildHeader(ext, eol) {
  const hasCookies = eol === '\r\n'
  if (COMMENT_STYLE[ext] === 'block') {
    // CSS：块注释。`* text=auto` 存储为 LF，故不加尾随空格。
    return `/*${eol} * ${COPYRIGHT}${eol} * ${SPDX}${eol} */${eol}${eol}`
  }
  void hasCookies
  return `// ${COPYRIGHT}${eol}// ${SPDX}${eol}${eol}`
}

/**
 * 判断文件**开头**是否已带声明头。
 *
 * 不能对整个文件做 `includes('SPDX-License-Identifier')` 子串匹配：本脚本自身就含有
 * 该字面量（作为常量），会把「只有常量、没有头」的文件误判为已声明（实测踩过）。
 * 仅限前几行也不够 —— `const SPDX = '...'` 落在第 1 行同样会命中（实测踩过）。
 *
 * 故用**结构判定**：该声明必须作为注释行出现（行注释 `//` 或块注释 ` * `），
 * 即严格匹配 `{注释标记}SPDX-License-Identifier: GPL-3.0-or-later`。字符串常量与
 * 普通代码因此骗不过去。
 */
function fileHasHeader(text) {
  // 跳过 shebang（它必须是首行）。
  let body = text
  if (body.startsWith('#!')) {
    const nl = body.indexOf('\n')
    if (nl < 0) return false
    body = body.slice(nl + 1)
  }
  // 头只允许出现在最前面几行；逐行要求「注释标记 + 完整声明」。
  const lines = body.split(/\r?\n/, 6)
  return lines.some((l) => /^\s*(?:\/\/|\*|\/\*)\s*SPDX-License-Identifier: GPL-3\.0-or-later\s*$/.test(l))
}

function main() {
  const checkOnly = process.argv.includes('--check')
  const files = trackedFiles().filter(inScope)

  let added = 0
  const missing = []
  const alreadyOk = []

  for (const rel of files) {
    const buf = readFileSync(rel)
    const text = buf.toString('utf8')

    // 开头已带声明 → 视为已处理（幂等，也保护手工写过的文件）。
    if (fileHasHeader(text)) {
      alreadyOk.push(rel)
      continue
    }

    if (checkOnly) {
      missing.push(rel)
      continue
    }

    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const header = buildHeader(extname(rel), eol)

    // shebang 必须保持在第一行：头部插到其后。
    let updated
    if (text.startsWith('#!')) {
      const nl = text.indexOf('\n')
      // shebang 行含其换行符，整体保留；其后紧接头（头自带一个空行分隔）。
      const firstLine = text.slice(0, nl + 1)
      const rest = text.slice(nl + 1)
      updated = firstLine + header + rest
    } else {
      updated = header + text
    }

    writeFileSync(rel, updated, 'utf8')
    added += 1
  }

  if (checkOnly) {
    if (missing.length > 0) {
      console.error(`✖ ${missing.length} 个源文件缺少版权头：`)
      for (const m of missing.slice(0, 40)) console.error(`   ${m}`)
      if (missing.length > 40) console.error(`   … 另有 ${missing.length - 40} 个`)
      console.error('\n修复：node scripts/add-license-headers.mjs')
      process.exit(1)
    }
    console.log(`✓ 版权头校验通过：${files.length} 个源文件均已声明（已含 ${alreadyOk.length} 个）`)
    return
  }

  console.log(`已写入 ${added} 个文件，跳过 ${alreadyOk.length} 个（已含声明）`)
}

main()
