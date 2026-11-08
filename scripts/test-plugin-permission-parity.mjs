#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 权限表一致性护栏（PR #325 review）。
//
// 桥方法 → 权限的映射有两份：运行时的 `src/plugins/sandbox.ts`（真正执行检查）
// 与 CLI 的 `packages/qomicex-cli/src/lib/permissions.ts`（`qomicex verify` 的
// 权限最小化扫描）。两份必须同步，否则：
//   - 只在 sandbox 登记 → CLI 把该权限判成「声明了但未使用」，**阻断发布**
//     （这正是 `deleteDir` 漏登记时的表现）；
//   - 只在 CLI 登记 → 运行时不做检查，等于没权限。
//
// `deleteDir` 就是这么漏的。本测试把两份表钉在一起。
//
// 运行：pnpm run test:plugin-permission-parity

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseMap(file) {
  const src = readFileSync(file, 'utf8')
  const start = src.indexOf('const METHOD_PERMISSIONS')
  assert.notEqual(start, -1, `${file} 里找不到 METHOD_PERMISSIONS`)
  const end = src.indexOf('\n}', start)
  assert.notEqual(end, -1, `${file} 里 METHOD_PERMISSIONS 没有闭合`)
  const body = src.slice(start, end)
  const map = new Map()
  for (const m of body.matchAll(/(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*'([^']*)'/g)) {
    map.set(m[1] ?? m[2], m[3])
  }
  return map
}

const runtimeMap = parseMap(join(root, 'src', 'plugins', 'sandbox.ts'))
const cliMap = parseMap(join(root, 'packages', 'qomicex-cli', 'src', 'lib', 'permissions.ts'))

assert.ok(runtimeMap.size > 50, `运行时权限表解析异常（只有 ${runtimeMap.size} 项）`)
assert.ok(cliMap.size > 50, `CLI 权限表解析异常（只有 ${cliMap.size} 项）`)

// 运行时表里「免权限」的方法（空串）不需要登记到 CLI：
// CLI 只需要知道「这个调用会要求某个权限」。
const freeInRuntime = new Set([...runtimeMap].filter(([, p]) => p === '').map(([m]) => m))

// 两侧的原始差集。免权限方法与已知豁免在后一步统一过滤——
// 不要在这里就按权限值排除，否则差集本身不可读、也无从复核。
const missingInCli = [...runtimeMap.keys()].filter(m => !cliMap.has(m))
const missingInRuntime = [...cliMap.keys()].filter(m => !runtimeMap.has(m))

// registerHook 是桥上的具名方法，不走 call() 的权限表；CLI 收录它是为了扫描
// `.call('registerHook')` 这种写法。属既有设计，单独豁免。
const KNOWN_CLI_ONLY = new Set(['registerHook'])

const valueMismatch = []
for (const [method, perm] of runtimeMap) {
  if (!perm) continue
  const cliPerm = cliMap.get(method)
  if (cliPerm !== undefined && cliPerm !== perm) valueMismatch.push(`${method}: 运行时 ${perm} / CLI ${cliPerm}`)
}

const unexpectedRuntimeOnly = missingInCli.filter(m => !freeInRuntime.has(m))
const unexpectedCliOnly = missingInRuntime.filter(m => !KNOWN_CLI_ONLY.has(m))

assert.deepEqual(
  unexpectedRuntimeOnly,
  [],
  `运行时权限表有、CLI 缺（qomicex verify 会误判「声明未使用」并阻断发布）：${unexpectedRuntimeOnly.join(', ')}`,
)
assert.deepEqual(
  unexpectedCliOnly,
  [],
  `CLI 权限表有、运行时缺（运行时不会检查，等于没有权限）：${unexpectedCliOnly.join(', ')}`,
)
assert.deepEqual(valueMismatch, [], `同一方法两表权限不一致：${valueMismatch.join('; ')}`)

console.log(
  `\n[test-plugin-permission-parity] OK — 运行时 ${runtimeMap.size} 项 / CLI ${cliMap.size} 项一致` +
    `（免权限 ${freeInRuntime.size} 项不进 CLI）`,
)
