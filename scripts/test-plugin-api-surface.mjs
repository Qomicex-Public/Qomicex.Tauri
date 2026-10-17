#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// 插件 API 可用性护栏（issue #264）。
//
// 为什么需要它：#260 与 #262 的共性是「同一个 API 有多份并行实现/清单，彼此漂移」：
//   - iframe 桥、inline 桥、主窗口 dispatch 白名单、switch、bridge 实现，五处各写一份；
//   - 任何一处漏登记，插件侧看到的不是报错而是「方法不存在」（Unsupported / Unknown），
//     或者更糟——调用发出去没有任何回执，Promise 永久挂起。
// 这类缺陷在人工测试里几乎碰不到（要恰好调用那个方法），必须用静态契约钉住。
//
// 本测试校验四条不变式：
//   1. 文档承诺的每个 API 都必须同时出现在白名单与 switch 里（否则调不到）
//   2. 白名单与 switch 必须一一对应（否则要么调不到、要么永远走不到）
//   3. 白名单里的权限串必须存在于权限目录（否则该 API 对任何插件都永远 403）
//   4. 桥侧暴露的非 call() 方法必须真有实现，且不能把它们也塞进白名单
//
// 运行：pnpm run test:plugin-api-surface

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = readFileSync(join(root, 'src', 'plugins', 'sandbox.ts'), 'utf8')
const catalog = readFileSync(join(root, 'packages', 'plugin-ui', 'src', 'plugins.ts'), 'utf8')
const docs = readFileSync(
  join(root, 'docs', 'junsi-dev-docs', '3-API规范', '插件系统API.md'),
  'utf8',
)

let checks = 0
function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

const sort = (arr) => [...arr].sort()
const diff = (a, b) => sort([...a].filter((x) => !b.has(x)))

/** METHOD_PERMISSIONS 的 key。 */
function permissionKeys() {
  const start = sandbox.indexOf('const METHOD_PERMISSIONS')
  assert.notEqual(start, -1, '找不到 METHOD_PERMISSIONS')
  const end = sandbox.indexOf('\n}', start)
  const body = sandbox.slice(start, end).split('\n').slice(1).join('\n')
  const keys = new Set()
  for (const m of body.matchAll(/(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*'/g)) keys.add(m[1] ?? m[2])
  return keys
}

/** 白名单里 key → 权限串。 */
function permissionMap() {
  const start = sandbox.indexOf('const METHOD_PERMISSIONS')
  const end = sandbox.indexOf('\n}', start)
  const body = sandbox.slice(start, end).split('\n').slice(1).join('\n')
  const map = new Map()
  for (const m of body.matchAll(/(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*'([^']+)'/g)) {
    map.set(m[1] ?? m[2], m[3])
  }
  return map
}

/** executePluginMethod 的 switch case。 */
function switchCases() {
  const start = sandbox.indexOf('async function executePluginMethod')
  assert.notEqual(start, -1, '找不到 executePluginMethod')
  const end = sandbox.indexOf('\n}\n', start)
  const keys = new Set()
  for (const m of sandbox.slice(start, end).matchAll(/case '([^']+)':/g)) keys.add(m[1])
  return keys
}

/** 权限目录里的 id。 */
function catalogIds() {
  const ids = new Set()
  for (const m of catalog.matchAll(/\bid:\s*'([^']+)'/g)) ids.add(m[1])
  return ids
}

/**
 * 文档承诺的 API 方法名：从「插件系统API.md」的 `__PLUGIN_API__.call('xxx')` 与
 * 具名调用里抽取。
 */
function documentedApi() {
  const names = new Set()
  for (const m of docs.matchAll(/__PLUGIN_API__\.call\(\s*'([^']+)'/g)) names.add(m[1])
  for (const m of docs.matchAll(/__PLUGIN_API__\.([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  return names
}

const perms = permissionKeys()
const map = permissionMap()
const cases = switchCases()
const catalogPerms = catalogIds()

/** 在桥脚本里直接实现的具名方法（其余 API 走 call()）。 */
const BRIDGE_LOCAL = new Set([
  'call', 'registerMethod', 'registerHook', 'callPlugin', 'proxyFetchStream',
  // 文档把这两个写成具名调用；桥里是转发到 call() 的薄封装
  'callWasm', 'listWasmPlugins',
])

// ---- 1. 白名单 ↔ switch 必须一一对应 ----
check('白名单有但 switch 缺（调用必报 Unknown method）', diff(perms, cases), [])
check('switch 有但白名单缺（永远走不到）', diff(cases, perms), [])

// ---- 2. 白名单的权限串必须都在权限目录里（否则对任何插件都恒 403）----
{
  const unknown = []
  for (const [method, perm] of map) {
    if (!catalogPerms.has(perm)) unknown.push(`${method} → ${perm}`)
  }
  check('白名单引用了权限目录里不存在的权限', unknown, [])
}

// ---- 3. 桥脚本里 call() 之外的方法必须都存在 ----
{
  const bridgeStart = sandbox.indexOf('const apiBridgeScript')
  const bridgeEnd = sandbox.indexOf('export function createSandbox', bridgeStart)
  const bridgeBody = sandbox.slice(bridgeStart, bridgeEnd === -1 ? undefined : bridgeEnd)
  const missing = []
  for (const name of BRIDGE_LOCAL) {
    if (name === 'call') continue
    // 桥里以 `name:` 或 `name: function` / `name: (` 形式定义
    if (!new RegExp(`\\b${name}\\s*:`).test(bridgeBody)) missing.push(name)
  }
  check('iframe 桥脚本缺少具名方法', missing, [])
}

// ---- 3b. inline 桥同样要提供这些具名方法 ----
{
  const inlineStart = sandbox.indexOf('const bridgeScript = document.createElement')
  const inlineEnd = sandbox.indexOf('hiddenHost.appendChild(bridgeScript)', inlineStart)
  const inlineBody = sandbox.slice(inlineStart, inlineEnd === -1 ? undefined : inlineEnd)
  const missing = []
  for (const name of BRIDGE_LOCAL) {
    if (name === 'call') continue
    if (!new RegExp(`\\b${name}\\s*:`).test(inlineBody)) missing.push(name)
  }
  check('inline 桥脚本缺少具名方法', missing, [])
}

// ---- 4. 具名方法与其 call() 同名方法必须语义一致（同一实现的两种入口）----
// 曾误以为两者不应重叠；实际上 registerMethod / callPlugin / proxyFetchStream
// 都是有意的双入口（文档同时给出具名用法与 call() 用法）。这里只断言：
// 桥里出现的具名方法，若同时是 call() 方法，则 switch 必须能处理它。
{
  const dual = [...BRIDGE_LOCAL].filter((m) => perms.has(m))
  const notHandled = dual.filter((m) => !cases.has(m) && m !== 'registerMethod')
  check('双入口方法里 switch 未实现（call() 路径会 Unknown method）', notHandled, [])
}

// ---- 5. 文档承诺的 API 必须可达：要么在白名单里，要么是具名方法 ----
{
  const doc = documentedApi()
  // 文档只覆盖部分 API（26 处调用点），解析到 0 个说明解析逻辑坏了
  check('文档里没抽到任何 API（解析失败即视为回归）', doc.size > 5, true)
  const unreachable = [...doc].filter((m) => !perms.has(m) && !BRIDGE_LOCAL.has(m))
  check('文档承诺但 call() 白名单与具名方法都没有', sort(unreachable), [])
}

// ---- 6. 白名单方法必须在 switch 里有实现（第 1 条已覆盖），此处不再重复解析 bridge 内部 ----

console.log(`\n[test-plugin-api-surface] OK — ${checks} 项断言通过（白名单 ${perms.size} 个方法）`)
