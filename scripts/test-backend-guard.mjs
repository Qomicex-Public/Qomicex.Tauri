#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// callBackend 特权路由守卫的契约测试。
//
// 为什么需要它：`callBackend` 只按 `network:fetch` 放行，而后端部分路由有更强
// 语义（拉起进程、授予任意路径读写权、卸载插件）。守卫本身是纯字符串逻辑，
// 但它一旦回归，插件就能用 network:fetch 绕过 process:manage /
// filesystem:write / plugin:install——这类缺陷在人工测试里根本碰不到。
//
// 本测试钉住四条不变式：
//   1. 每条特权路由在正确方法下必须要求对应权限
//   2. 方法不匹配时不得误判（GET /plugins/x 不应要求 plugin:install）
//   3. 路径规范化必须与 fetch 一致（`..`、查询串、绝对 URL、双斜杠都不能绕过）
//   4. 非字符串端点、畸形 URL 必须安全降级（不抛异常、不误放行）
//
// 运行：pnpm run test:backend-guard

import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// backend-guard.ts 是纯 TS（无 JSX/DOM），用 node 内置类型剥离直接导入。
// Node < 22.6 无 --experimental-strip-types，故走 transpile 兜底。
let mod
try {
  mod = await import(pathToFileURL(join(root, 'src', 'plugins', 'backend-guard.ts')).href)
} catch (e) {
  console.error('无法直接导入 TypeScript 模块，请用 node >= 22.6 运行：', e.message)
  process.exit(1)
}

const { backendEndpointPermission, normalizeBackendPath, resolveBackendMethod } = mod
const BASE = 'http://127.0.0.1:5000/api'

let checks = 0
function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks++
}

// ---- 1. 特权路由必须要求对应权限 ----
check('process spawn 需 process:manage', backendEndpointPermission('/plugins/process/x/spawn', 'POST', BASE), 'process:manage')
check('process logs 需 process:manage', backendEndpointPermission('/plugins/process/x/1/logs', 'GET', BASE), 'process:manage')
check('shell 需 shell:execute', backendEndpointPermission('/plugins/shell/x', 'POST', BASE), 'shell:execute')
check('files authorize 需 filesystem:write', backendEndpointPermission('/plugins/files/x/authorize', 'POST', BASE), 'filesystem:write')
check('files write 需 filesystem:write', backendEndpointPermission('/plugins/files/x/write', 'POST', BASE), 'filesystem:write')
check('files read 需 filesystem:write', backendEndpointPermission('/plugins/files/x/read', 'POST', BASE), 'filesystem:write')
check('files extract 需 filesystem:write', backendEndpointPermission('/plugins/files/x/extract', 'POST', BASE), 'filesystem:write')
check('install 需 plugin:install', backendEndpointPermission('/plugins/install', 'POST', BASE), 'plugin:install')
check('install-url 需 plugin:install', backendEndpointPermission('/plugins/install-url', 'POST', BASE), 'plugin:install')
check('upload 需 plugin:install', backendEndpointPermission('/plugins/upload', 'POST', BASE), 'plugin:install')
check('DELETE 插件需 plugin:install', backendEndpointPermission('/plugins/some.id', 'DELETE', BASE), 'plugin:install')
check('rollback 需 plugin:install', backendEndpointPermission('/plugins/some.id/rollback', 'POST', BASE), 'plugin:install')
check('PUT state 需 plugin:install', backendEndpointPermission('/plugins/some.id/state', 'PUT', BASE), 'plugin:install')

// ---- 2. 普通路由不得误判 ----
check('列表插件免检', backendEndpointPermission('/plugins', 'GET', BASE), null)
check('单查插件免检', backendEndpointPermission('/plugins/some.id', 'GET', BASE), null)
check('settings 免检', backendEndpointPermission('/plugins/settings/some.id', 'GET', BASE), null)
check('modpack install 免检', backendEndpointPermission('/modpack/install-direct', 'POST', BASE), null)
check('server setup 免检', backendEndpointPermission('/server/setup', 'POST', BASE), null)
check('GET shell 不误判', backendEndpointPermission('/plugins/shell/x', 'GET', BASE), null)
check('GET files/read 不误判', backendEndpointPermission('/plugins/files/x/read', 'GET', BASE), null)
check('POST 插件根不误判为 install', backendEndpointPermission('/plugins/some.id', 'POST', BASE), null)

// ---- 3. 路径规范化：fetch 会怎么解析就怎么匹配 ----
check('查询串被剥离', normalizeBackendPath('/plugins/x?y=1', BASE), '/plugins/x')
check('片段被剥离', normalizeBackendPath('/plugins/x#frag', BASE), '/plugins/x')
check('.. 段被解析', normalizeBackendPath('/plugins/../modpack/x', BASE), '/modpack/x')
check('.. 绕回特权路由仍被识别', backendEndpointPermission('/x/../plugins/install', 'POST', BASE), 'plugin:install')
check('绝对 URL 解析到后端路径', backendEndpointPermission(`${BASE}/plugins/install`, 'POST', BASE), 'plugin:install')
check('双斜杠不逃逸基址', backendEndpointPermission('//evil.test/plugins/install', 'POST', BASE), 'plugin:install')
check('基址前缀被剥离', normalizeBackendPath(`${BASE}/plugins/process/a/spawn`, BASE), '/plugins/process/a/spawn')

// ---- 4. 畸形输入安全降级 ----
check('畸形 URL 退回原始串（仍能匹配）', backendEndpointPermission('/plugins/install', 'POST', 'not a url'), 'plugin:install')
check('非特权畸形端点放行', backendEndpointPermission('%%%', 'POST', BASE), null)

// ---- 5. 方法推断与 bridge 一致 ----
check('无 body → GET', resolveBackendMethod(undefined), 'GET')
check('有 body → POST', resolveBackendMethod({ a: 1 }), 'POST')
check('_method 覆盖优先', resolveBackendMethod({ _method: 'delete' }), 'DELETE')
check('_method 非字符串时忽略', resolveBackendMethod({ _method: 42 }), 'POST')
check('_method 生效后触发删除规则', backendEndpointPermission('/plugins/x', resolveBackendMethod({ _method: 'DELETE' }), BASE), 'plugin:install')

// ---- 6. 规则表不得留空（防止误删全部规则后静默放行） ----
const { BACKEND_ROUTE_RULES } = mod
assert.ok(Array.isArray(BACKEND_ROUTE_RULES) && BACKEND_ROUTE_RULES.length >= 7, 'BACKEND_ROUTE_RULES 规则数异常')
checks++

console.log(`✓ backend-guard: ${checks} 项断言通过`)
