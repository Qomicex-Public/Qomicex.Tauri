#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/lib/downloadNamePool.ts 的回归测试（issue #223 评审）。
//
// 沿用 test-dependency-install-plan.mjs 的做法：用仓库自带的 tsc 编译**真实源码**
// 到临时目录再断言，不引入测试框架，也不抄一份逻辑自证。
//
// 运行：pnpm run test:download-name-pool
//
// 守的契约（都是「藏在下载批次内部时只能靠人读、回归无声」的那类）：
//   1. 同一实例并发批次共享一个池 —— 后一批次看得到前一批次已预留的名字
//   2. 池里存小写键，冲突判定大小写不敏感（Windows / macOS 默认不区分大小写）
//   3. 引用计数：先结束的批次不删池，新批次仍看到已预留的名字
//   4. 计数归零才真正释放，释放后新池是空的
//   5. 种子名（实例已安装文件名）被规范化后进入池
//   6. 真实拼写保留：只有比较口径归一，返回的文件名不变

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'src', 'lib', 'downloadNamePool.ts')
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-name-pool-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

const TEMPLATE = '{name}-{version}'

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const {
    acquireNamePool,
    releaseNamePool,
    hasNamePool,
    namePoolRefCount,
    makeNaming,
  } = require(join(outDir, 'downloadNamePool.js'))

  // 简单模板渲染器：只处理 {name} / {version} / {cn}，与生产实现同形即可
  const fmt = (tpl, vars) =>
    tpl
      .replace('{cn}', vars.cnName ?? '')
      .replace('{name}', vars.name)
      .replace('{version}', vars.version)
  const item = (fileName, name) => ({ fileName, name, url: 'https://x', category: 'mod' })

  // ---- 1. 并发批次共享池 ----
  const idA = 'inst-A'
  const poolA1 = acquireNamePool(idA, ['fabric-api-0.1.jar'])
  const namingA1 = makeNaming(TEMPLATE, poolA1, fmt)
  const first = namingA1(item('fabric-api-0.1.jar', 'fabric-api'))
  check('种子名占位后追加序号', first.fileName, 'fabric-api-0.1(1).jar')

  // 第二个批次拿同一个池，必须看得到前一个批次已预留的名字
  const poolA2 = acquireNamePool(idA, [])
  check('并发批次拿到同一个池实例', poolA2 === poolA1, true)
  const namingA2 = makeNaming(TEMPLATE, poolA2, fmt)
  const second = namingA2(item('fabric-api-0.1.jar', 'fabric-api'))
  check('后一批次避让前一批次已预留的名字', second.fileName, 'fabric-api-0.1(2).jar')

  // ---- 1b. 真正的同时并发：两个闭包先建好，再交替预留 ----
  // 这是快照式实现唯一会暴露的场景：若 makeNaming 在创建时快照一份池，
  // 后建的那个看不到先建之后别人预留的名字，两边会分配同一个目标名。
  const idRace = 'inst-race'
  const raceP = acquireNamePool(idRace, [])
  // 两个批次同时启动：先各自建好闭包（此刻池是空的）
  const raceBatch1 = makeNaming(TEMPLATE, raceP, fmt)
  const raceBatch2 = makeNaming(TEMPLATE, raceP, fmt)
  const race1 = raceBatch1(item('shared-1.0.jar', 'shared'))
  const race2 = raceBatch2(item('shared-1.0.jar', 'shared'))
  check('并发首轮之一拿到原名', race1.fileName, 'shared-1.0.jar')
  assert.notEqual(
    race2.fileName,
    race1.fileName,
    `两个并发批次不得分配同一个目标名，实际都是 ${race2.fileName}`,
  )
  checks += 1
  releaseNamePool(idRace)
  releaseNamePool(idRace)

  // ---- 2. 大小写不敏感 ----
  // 实例里已有 Foo.jar 时，生成的 foo.jar 必须避让（Windows / macOS 同一路径）
  const idCase = 'inst-case'
  const poolCase = acquireNamePool(idCase, ['Foo-1.0.jar'])
  const namingCase = makeNaming(TEMPLATE, poolCase, fmt)
  const caseResult = namingCase(item('foo-1.0.jar', 'foo'))
  assert.notEqual(
    caseResult.fileName.toLowerCase(),
    'foo-1.0.jar',
    `大小写不同也必须避让，实际得到 ${caseResult.fileName}`,
  )
  checks += 1

  // ---- 3. 引用计数：先结束的批次不删池 ----
  releaseNamePool(idA) // A1 结束，A2 仍在跑
  check('仍有持有者时池保留', hasNamePool(idA), true)
  check('引用计数递减', namePoolRefCount(idA), 1)
  const poolA3 = acquireNamePool(idA, [])
  check('新批次仍拿到原池（看得到 A1 的预留）', poolA3, poolA1)
  const namingA3 = makeNaming(TEMPLATE, poolA3, fmt)
  check(
    '新批次继续避让早期预留',
    namingA3(item('fabric-api-0.1.jar', 'fabric-api')).fileName,
    'fabric-api-0.1(3).jar',
  )

  // ---- 4. 归零释放 ----
  releaseNamePool(idA) // A2
  releaseNamePool(idA) // A3
  check('计数归零后池被释放', hasNamePool(idA), false)
  check('释放后计数为 0', namePoolRefCount(idA), 0)
  const poolFresh = acquireNamePool(idA, [])
  const namingFresh = makeNaming(TEMPLATE, poolFresh, fmt)
  check('新池是空的，不再避让', namingFresh(item('fabric-api-0.1.jar', 'fabric-api')).fileName, 'fabric-api-0.1.jar')

  // ---- 5. 种子名规范化 ----
  const idSeed = 'inst-seed'
  acquireNamePool(idSeed, ['Mixed-Case-2.0.jar'])
  const poolSeed = acquireNamePool(idSeed, [])
  const namingSeed = makeNaming(TEMPLATE, poolSeed, fmt)
  const seeded = namingSeed(item('mixed-case-2.0.jar', 'mixed-case'))
  assert.notEqual(seeded.fileName.toLowerCase(), 'mixed-case-2.0.jar', '种子名应以小写键参与比较')
  checks += 1
  releaseNamePool(idSeed)
  releaseNamePool(idSeed)

  // ---- 6. 真实拼写保留 ----
  // 池里是小写键，但返回值必须保留生成时的拼写（用户看到的名称）
  const idSpell = 'inst-spell'
  const poolSpell = acquireNamePool(idSpell, [])
  const namingSpell = makeNaming('{name}', poolSpell, fmt)
  const spelled = namingSpell(item('Whatever.jar', 'MyMod'))
  check('返回值保留原拼写', spelled.fileName, 'MyMod.jar')
  check('池里存的是小写键', poolSpell.has('mymod.jar'), true)
  releaseNamePool(idSpell)

  // ---- 7. 非模板命中时也预留（防同一批次内重复） ----
  const idDup = 'inst-dup'
  const poolDup = acquireNamePool(idDup, [])
  const namingDup = makeNaming('{name}', poolDup, fmt)
  check('首个同名占位', namingDup(item('a.jar', 'same')).fileName, 'same.jar')
  check('同批次第二个同名避让', namingDup(item('b.jar', 'same')).fileName, 'same(1).jar')
  releaseNamePool(idDup)

  console.log(`\n✓ downloadNamePool: ${checks} 项断言通过`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
