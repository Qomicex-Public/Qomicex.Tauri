#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/api/ipc.ts 流式通道的请求头回归（issue #262）。
//
// 为什么需要它：IPC 模式下 `ipcStream` 把 headers 原样塞进 Tauri invoke，后端
// `handle_conn` 重建 Axum 请求时不会再补默认值。`fetch` 会自动生成 Content-Type，
// IPC 不会 —— 两者不一致时，`/plugins/proxy`（`Json` 提取器）在 IPC 模式下恒返回
// 415，所有插件的流式能力静默失效，而同一请求走 fetch 却正常。
//
// 该分支依赖 Tauri invoke，无法在 Node 里端到端跑；这里改为对**源码**做契约断言
// （沿用 test-plugin-theme-sync 的「读真实源码」思路，只是不做编译）。
//
// 运行：pnpm run test:plugin-ipc-stream-headers

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'src', 'api', 'ipc.ts'), 'utf8')
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

/** 取出某个函数的函数体（从签名到下一个顶层 `}`），用于限定检查范围。 */
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

const ipcBody = functionBody('ipcStream')
const httpBody = functionBody('httpStream')

// ---- IPC 分支必须自己补 Content-Type（fetch 会自动补，IPC 不会）----
check(
  'ipcStream 为请求头补默认 Content-Type',
  /headers:\s*\{\s*'Content-Type':\s*'application\/json'/.test(ipcBody),
  true,
)
check(
  '默认头在调用方头之前（调用方值优先）',
  ipcBody.indexOf("'Content-Type': 'application/json'") < ipcBody.indexOf('...opts?.headers'),
  true,
)
check(
  'ipcStream 仍透传调用方提供的头',
  ipcBody.includes('...opts?.headers'),
  true,
)

// ---- HTTP 分支保持同样的默认值：两条路径行为必须一致 ----
check(
  'httpStream 同样补默认 Content-Type',
  /headers:\s*\{\s*'Content-Type':\s*'application\/json'/.test(httpBody),
  true,
)

// ---- 反向保护：不允许出现「空 headers 兜底」的写法（正是 #262 的缺陷形态）----
check(
  'ipcStream 不再使用 headers: opts?.headers ?? {} 的空兜底',
  /headers:\s*opts\?\.headers\s*\?\?\s*\{\s*\}/.test(ipcBody),
  false,
)

console.log(`\n[test-plugin-ipc-stream-headers] OK — ${checks} 项断言通过`)
