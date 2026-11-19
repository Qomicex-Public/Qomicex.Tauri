#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/stores/downloadStore.ts 的回归测试（issue #366）。
//
// 沿用 test-download-name-pool.mjs 的约定：用仓库自带 tsc 把**真实源码**编译到
// 临时目录再断言；localStorage 用内存 shim（模块加载时就会读一次）。
//
// 运行：pnpm run test:download-store
//
// 覆盖的契约（issue #366：重试出现 3 张不同名同进度卡片、重试过一次后没有重试按钮）：
//   1. 同一 instanceId 的安装卡只保留一张（SSE 自动补卡 vs 对话框/重试建卡）
//   2. 合并后保留 retry 描述符与用户命名的卡片名，自动补卡的回退名不覆盖它
//   3. 重试把卡片挂到新实例时，收编 SSE 已自动补出的同实例卡片
//   4. 非安装卡（batch/file）同实例不被误合并

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'src', 'stores', 'downloadStore.ts')
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-download-store-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

// 模块加载即读 localStorage：必须在 require 之前装好。
const storage = new Map()
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => void storage.set(k, String(v)),
  removeItem: (k) => void storage.delete(k),
}

function installCard(overrides) {
  return {
    id: 'auto-1',
    name: 'inst-1',
    type: 'modpack',
    gameVersion: '1.20.1',
    status: 'downloading',
    progress: 0,
    createdAt: '2026-11-18T00:00:00.000Z',
    instanceId: 'inst-1',
    ...overrides,
  }
}

const RETRY = {
  kind: 'modpack',
  name: '我的整合包',
  gameVersion: '1.20.1',
  source: 'modrinth',
  projectId: 'p',
  versionId: 'v',
  gameDir: '/g',
  versionIsolation: true,
}

try {
  execFileSync(
    process.execPath,
    [
      tsc,
      source,
      '--outDir',
      outDir,
      '--module',
      'commonjs',
      '--target',
      'es2020',
      '--skipLibCheck',
    ],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  // tsc 按公共源目录推导 rootDir：downloadStore.ts 带了 '../types/index.ts' 的
  // 类型导入，输出落在 stores/ 子目录。
  const { getTasks, addTask, updateTask, clearAllTasks } = require(
    join(outDir, 'stores', 'downloadStore.js'),
  )

  // 1) SSE 先自动补卡（无 retry、名字回退为 instanceId），对话框随后建正式卡。
  clearAllTasks()
  addTask(installCard({}))
  addTask(
    installCard({
      name: '我的整合包',
      type: 'modpack',
      icon: 'https://cdn.example/icon.png',
      retry: RETRY,
    }),
  )
  check('同一实例只留一张卡', getTasks().length, 1)
  check('保留 retry 描述符', getTasks()[0].retry, RETRY)
  check(
    '保留用户命名与图标',
    [getTasks()[0].name, getTasks()[0].icon],
    ['我的整合包', 'https://cdn.example/icon.png'],
  )

  // 2) 反向顺序：正式卡先建，SSE 自动补卡不得覆盖名字与 retry。
  clearAllTasks()
  addTask(installCard({ id: 'inst-1', name: '我的整合包', retry: RETRY }))
  addTask(installCard({ id: 'inst-1', name: 'inst-1' }))
  check('反向顺序仍只有一张卡', getTasks().length, 1)
  check('自动补卡不覆盖名字', getTasks()[0].name, '我的整合包')
  check('自动补卡不丢 retry', getTasks()[0].retry, RETRY)

  // 3) 游戏安装卡（type=game）与 SSE 自动补卡（type=modpack）也要合并。
  clearAllTasks()
  addTask(installCard({ id: 'inst-1', type: 'game', name: '我的整合包', retry: RETRY }))
  addTask(installCard({ id: 'auto-x', type: 'modpack', name: 'inst-1' }))
  check('game/modpack 同实例合并', getTasks().length, 1)
  check('合并后仍是游戏卡', getTasks()[0].type, 'game')

  // 4) 重试：卡片挂到新实例时收编该实例的自动补卡。
  clearAllTasks()
  addTask(installCard({ id: 'inst-1', name: '我的整合包', retry: RETRY, status: 'failed' }))
  addTask(installCard({ id: 'inst-2', instanceId: 'inst-2', name: 'inst-2' }))
  check('重试前的两张卡', getTasks().length, 2)
  updateTask('inst-1', { instanceId: 'inst-2', status: 'queued', retryPending: false })
  check('重试后只剩一张卡', getTasks().length, 1)
  check('重试卡指向新实例', getTasks()[0].instanceId, 'inst-2')
  check('重试后仍带 retry（重试按钮不消失）', getTasks()[0].retry, RETRY)
  check('重试后名字不变', getTasks()[0].name, '我的整合包')

  // 5) 非安装卡（batch/file）共用实例 id 时不得被安装卡合并掉。
  clearAllTasks()
  addTask(installCard({ id: 'inst-1', name: '我的整合包', retry: RETRY }))
  addTask({
    id: 'batch-1',
    name: '模组快捷安装',
    type: 'batch',
    gameVersion: '1.20.1',
    status: 'downloading',
    progress: 0,
    createdAt: '2026-11-18T00:00:00.000Z',
    instanceId: 'inst-1',
  })
  check('batch 卡独立于安装卡', getTasks().length, 2)

  // 6) 重试收编同实例卡片时，batch/file 卡必须保留（review：无关卡片消失）。
  updateTask('inst-1', { instanceId: 'inst-1', status: 'queued' })
  check('收编不影响 batch 卡', getTasks().length, 2)
  check('batch 卡仍在', getTasks().some((t) => t.id === 'batch-1'), true)

  // 7) 整合包更新卡合并后不得继承安装卡的 retry 描述符（review：更新重试变重装）。
  clearAllTasks()
  addTask(installCard({ id: 'inst-1', name: '我的整合包', retry: RETRY }))
  addTask(installCard({ id: 'inst-1', type: 'modpack-update', name: '我的整合包' }))
  check('更新卡不继承安装 retry', getTasks()[0].retry, undefined)

  // 8) 启动加载时对已持久化的同实例重复卡去重（review：持久化重复卡残留）。
  storage.set(
    'qomicex-download-tasks',
    JSON.stringify([
      installCard({ id: 'auto-dup', name: 'inst-dup', instanceId: 'inst-dup' }),
      installCard({
        id: 'inst-dup',
        instanceId: 'inst-dup',
        name: '我的整合包',
        retry: RETRY,
      }),
    ]),
  )
  const storePath = join(outDir, 'stores', 'downloadStore.js')
  delete require.cache[require.resolve(storePath)]
  const reloaded = require(storePath)
  check('持久化重复卡只留一张', reloaded.getTasks().length, 1)
  check('保留带 retry 的那张', reloaded.getTasks()[0].retry, RETRY)
  // 后续断言仍用原模块实例（其内存状态没有被重新加载污染）。
  storage.delete('qomicex-download-tasks')

  console.log(`downloadStore 去重契约全部通过（${checks} 项断言）`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
