#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/api/ipc.ts 流式通道的请求头回归（issue #262）。
//
// 为什么需要它：IPC 模式下 `ipcStream` 把 headers 原样塞进 Tauri invoke，后端
// handle_conn 不会再补默认值。`fetch` 会自动生成 Content-Type，IPC 不会 —— 两者
// 不一致时，`/plugins/proxy`（`Json` 提取器）在 IPC 模式下恒返回 415，所有插件的
// 流式能力静默失效，而同一请求走 fetch 却正常。
//
// 该分支依赖 Tauri invoke，无法在 Node 里端到端跑；这里把 `withDefaultContentType`
// 抽出来直接调用验证（纯函数），并对两个分支的调用点做源码断言。
//
// 运行：pnpm run test:plugin-ipc-stream-headers

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(root, 'src', 'api', 'ipc.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const outDir = mkdtempSync(join(tmpdir(), 'qmx-ipc-stream-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

const source = readFileSync(sourcePath, 'utf8')

/** 取出某个函数的函数体，用于限定源码断言范围。 */
function functionBody(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `源码中找不到 function ${name}`)
  const braceStart = source.indexOf('{', start)
  let depth = 0
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(braceStart, i + 1)
    }
  }
  throw new Error(`function ${name} 的函数体未闭合`)
}

try {
  // withDefaultContentType 是纯函数（无 import 依赖）：单独抽出来编译执行
  const fnStart = source.indexOf('function withDefaultContentType(')
  assert.notEqual(fnStart, -1, '源码中找不到 withDefaultContentType')
  const fnEnd = source.indexOf('\nfunction ', fnStart + 10)
  const fnSource = source.slice(fnStart, fnEnd === -1 ? source.length : fnEnd)
  const probe = join(outDir, 'probe.ts')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(probe, `${fnSource}\nexport { withDefaultContentType }\n`, 'utf8')
  execFileSync(
    process.execPath,
    [tsc, probe, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const withDefaultContentType = require(join(outDir, 'probe.js')).withDefaultContentType
  check('导出 withDefaultContentType', typeof withDefaultContentType, 'function')

  // ---- 未传 headers → 默认 application/json ----
  check('未传 headers 时补默认 Content-Type', withDefaultContentType(undefined), {
    'Content-Type': 'application/json',
  })

  // ---- 调用方值优先（同名大小写）----
  check('调用方 Content-Type 优先', withDefaultContentType({ 'Content-Type': 'text/plain' }), {
    'Content-Type': 'text/plain',
  })

  // ---- 大小写不敏感：不能并存两个 Content-Type ----
  {
    const merged = withDefaultContentType({ 'content-type': 'text/plain' })
    const keys = Object.keys(merged).filter((k) => k.toLowerCase() === 'content-type')
    check('小写 content-type 时不产生重复头', keys.length, 1)
    check('小写 content-type 的值生效', merged[keys[0]], 'text/plain')
  }
  {
    const merged = withDefaultContentType({ 'Content-type': 'application/xml' })
    const keys = Object.keys(merged).filter((k) => k.toLowerCase() === 'content-type')
    check('混合大小写时不产生重复头', keys.length, 1)
    check('混合大小写的值生效', merged[keys[0]], 'application/xml')
  }

  // ---- 其它头与默认头并存 ----
  {
    const merged = withDefaultContentType({ Authorization: 'Bearer x' })
    check('Authorization 透传', merged.Authorization, 'Bearer x')
    check('同时保留默认 Content-Type', merged['Content-Type'], 'application/json')
  }

  // ---- 两个分支都必须走同一份默认头逻辑 ----
  check('ipcStream 使用 withDefaultContentType', functionBody('ipcStream').includes('withDefaultContentType'), true)
  check('httpStream 使用 withDefaultContentType', functionBody('httpStream').includes('withDefaultContentType'), true)
  // 反向保护：不允许回退成空 headers 兜底（#262 的缺陷形态）
  check(
    'ipcStream 不再有空 headers 兜底',
    /headers:\s*opts\?\.headers\s*\?\?\s*\{\s*\}/.test(functionBody('ipcStream')),
    false,
  )

  console.log(`\n[test-plugin-ipc-stream-headers] OK — ${checks} 项断言通过`)
} catch (err) {
  console.error(`\n[test-plugin-ipc-stream-headers] FAILED\n${err?.message ?? err}`)
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
