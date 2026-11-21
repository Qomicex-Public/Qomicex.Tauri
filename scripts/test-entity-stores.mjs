#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/lib/entityPatch.ts 的回归测试（instances/accounts 共享 store 的写入契约）。
//
// 沿用 test-download-store-dedupe.mjs 的约定：用仓库自带 tsc 把**真实源码**编译到
// 临时目录再断言。
//
// 运行：pnpm run test:entity-stores
//
// 覆盖的契约：
//   1. upsert 已存在实体 → 原位替换（保持列表顺序），不重复追加
//   2. upsert 新实体 → 追加
//   3. remove → 删除实体；仅当默认项就是它时清空默认
//   4. default → 只改默认项，不动列表
//   5. reload → 原样返回（由 store 层重拉）

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sources = [
  join(repoRoot, 'src', 'lib', 'entityPatch.ts'),
  join(repoRoot, 'src', 'lib', 'downloadStatus.ts'),
]
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-entity-patch-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

const inst = (id, extra = {}) => ({ id, name: id, gameDir: '/g', ...extra })
const acc = (uuid, extra = {}) => ({ uuid, name: uuid, isDefault: false, ...extra })

try {
  execFileSync(
    process.execPath,
    [tsc, ...sources, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  // tsc 按公共源目录推导 rootDir：两个文件都在 src/lib，输出落在 lib/ 子目录。
  const { patchInstances, patchAccounts, stampDefaultInstance } = require(join(outDir, 'lib', 'entityPatch.js'))
  const { STATUS_CONFIG, isTaskStatus } = require(join(outDir, 'lib', 'downloadStatus.js'))

  const base = {
    instances: [inst('a'), inst('b'), inst('c')],
    defaultInstance: inst('b'),
  }

  // 1) 已存在 → 原位替换，顺序不变；被更新的正是默认实例时默认对象同步替换
  const replaced = patchInstances(base, { type: 'upsert', instance: inst('b', { name: '新名字' }) })
  check('原位替换保持顺序', replaced.instances.map((i) => i.id), ['a', 'b', 'c'])
  check('替换写入新值', replaced.instances[1].name, '新名字')
  check('默认实例被更新时默认对象同步替换', replaced.defaultInstance.name, '新名字')
  check('默认实例补丁保住 isDefault 标记', replaced.defaultInstance.isDefault, true)

  const replacedOther = patchInstances(base, { type: 'upsert', instance: inst('a', { name: '别的' }) })
  check('更新非默认实例不动默认对象', replacedOther.defaultInstance, base.defaultInstance)

  // 2) 不存在 → 追加
  const appended = patchInstances(base, { type: 'upsert', instance: inst('d') })
  check('新实体追加到末尾', appended.instances.map((i) => i.id), ['a', 'b', 'c', 'd'])

  // 3) 删除默认实例 → 默认清空
  const removedDefault = patchInstances(base, { type: 'remove', id: 'b' })
  check('删除后列表移除', removedDefault.instances.map((i) => i.id), ['a', 'c'])
  check('删除默认实例时清空默认', removedDefault.defaultInstance, null)

  // 4) 删除非默认实例 → 默认保留
  const removedOther = patchInstances(base, { type: 'remove', id: 'a' })
  check('删除非默认实例保留默认', removedOther.defaultInstance.id, 'b')

  // 5) default → 默认项与列表标记一起切换（安装对话框按 isDefault 预选）
  const nextDefault = patchInstances(base, { type: 'default', instance: inst('c') })
  check('设置默认不改列表内容与顺序', nextDefault.instances.map((i) => i.id), ['a', 'b', 'c'])
  check('设置默认同步列表标记', nextDefault.instances.map((i) => i.isDefault), [false, false, true])
  check('设置默认生效', nextDefault.defaultInstance.id, 'c')

  const cleared = patchInstances(nextDefault, { type: 'default', instance: null })
  check('清除默认后列表标记全 false', cleared.instances.map((i) => i.isDefault), [false, false, false])

  // 5b) stampDefaultInstance：空默认也把残留标记清掉
  check(
    'stamp 按默认项重写标记',
    stampDefaultInstance([inst('a', { isDefault: true }), inst('b')], inst('b')).map((i) => i.isDefault),
    [false, true],
  )

  // 6) reload 原样返回
  check('reload 原样返回', patchInstances(base, { type: 'reload' }), base)

  // 账号契约与实例一致
  const accBase = {
    accounts: [acc('u1'), acc('u2', { isDefault: true })],
    defaultAccount: acc('u2', { isDefault: true }),
  }
  check(
    '账号原位替换',
    patchAccounts(accBase, { type: 'upsert', account: acc('u1', { name: '改过' }) }).accounts[0].name,
    '改过',
  )
  check(
    '账号新增追加',
    patchAccounts(accBase, { type: 'upsert', account: acc('u3') }).accounts.map((a) => a.uuid),
    ['u1', 'u2', 'u3'],
  )
  check(
    '账号删除默认时清空默认',
    patchAccounts(accBase, { type: 'remove', uuid: 'u2' }).defaultAccount,
    null,
  )
  check('账号删除非默认保留默认', patchAccounts(accBase, { type: 'remove', uuid: 'u1' }).defaultAccount.uuid, 'u2')
  const accDefault = patchAccounts(accBase, { type: 'default', account: acc('u1', { isDefault: true }) })
  check('账号切换默认同步列表标记', accDefault.accounts.map((a) => a.isDefault), [true, false])
  check('账号切换默认写入默认项', accDefault.defaultAccount.uuid, 'u1')
  check('账号 reload 原样返回', patchAccounts(accBase, { type: 'reload' }), accBase)

  // 7) 状态表完整性 + 后端字符串校验（只认自有属性）
  check('状态表覆盖全部任务状态', Object.keys(STATUS_CONFIG).sort(), [
    'awaiting-files', 'cancelled', 'completed', 'downloading', 'failed', 'paused', 'queued',
  ])
  check('合法状态通过', isTaskStatus('awaiting-files'), true)
  check('未知状态拒绝', isTaskStatus('bogus'), false)
  check('原型键拒绝', isTaskStatus('constructor'), false)

  console.log(`entity-patch: ${checks} 项通过`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
