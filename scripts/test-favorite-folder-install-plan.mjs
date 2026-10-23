#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/lib/favoriteFolderInstallPlan.ts 的回归测试（issue #223）。
//
// 沿用 test-dependency-install-plan.mjs 的做法：用仓库自带的 tsc 编译**真实源码**
// 到临时目录再断言，不引入测试框架，也不抄一份逻辑自证。
//
// 运行：pnpm run test:favorite-folder-install-plan
//
// 守的契约：
//   1. 已安装的条目既不重下也不删除（ADR-112 / issue #249 同口径）
//   2. 根资源优先于依赖（同一项目两种身份时按根资源处理）
//   3. 共享依赖只下载一次，保留首次出现的版本
//   4. 来源隔离：同一 id 在不同来源下互不影响
//   5. 空 URL / 无兼容版本 / 非 mod / 不支持来源 → 进 skipped 且带原因
//   6. 只有被采纳的根资源才带依赖进来
//   7. deletions 恒为空（批量安装只做新增）
//   8. 上游文件名原样透传，不在计划阶段改写字（命名去重属于批任务的命名域）

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'src', 'lib', 'favoriteFolderInstallPlan.ts')
const tsc = join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-fav-plan-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

/** 构造一个根资源解析结果。 */
function mkRoot(source_, id, title, version, deps = [], category = 'mod') {
  return { root: { source: source_, id, title, category }, version, deps }
}

const ver = (fileName, url = `https://cdn.example/${fileName}`) => ({ fileName, url })
const dep = (projectId, fileName, source_ = 'modrinth', downloadUrl, category = 'mod') => ({
  projectId,
  source: source_,
  downloadUrl: downloadUrl ?? `https://cdn.example/${fileName}`,
  fileName,
  category,
  name: projectId,
})

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const { planFavoriteFolderInstall, favoriteInstallKey, countSkipped } = require(
    join(outDir, 'favoriteFolderInstallPlan.js'),
  )

  // ---- 1. 正常：两个根资源各自带依赖 ----
  const base = planFavoriteFolderInstall(
    [
      mkRoot('modrinth', 'A', 'Mod A', ver('a-1.0.jar'), [dep('D1', 'dep1-2.0.jar')]),
      mkRoot('curseforge', 'B', 'Mod B', ver('b-1.0.jar')),
    ],
    new Set(),
  )
  check('根资源 + 依赖都进入下载', base.downloads.length, 3)
  check(
    '根资源排在前、依赖在后',
    base.downloads.map((d) => d.fileName),
    ['a-1.0.jar', 'b-1.0.jar', 'dep1-2.0.jar'],
  )
  check('deletions 恒为空', base.deletions, [])
  check('无跳过', base.skipped, [])

  // ---- 2. 已安装：不重下、不删除 ----
  const installedPlan = planFavoriteFolderInstall(
    [mkRoot('modrinth', 'A', 'Mod A', ver('a-1.0.jar'))],
    new Set([favoriteInstallKey('modrinth', 'A')]),
  )
  check('已安装的根资源不下载', installedPlan.downloads, [])
  check('已安装的根资源不删除', installedPlan.deletions, [])
  check('已安装进 skipped', installedPlan.skipped.map((s) => s.reason), ['installed'])

  // 已安装的依赖同样跳过，且不影响其它依赖
  const installedDepPlan = planFavoriteFolderInstall(
    [
      mkRoot('modrinth', 'A', 'Mod A', ver('a-1.0.jar'), [
        dep('D1', 'dep1-2.0.jar'),
        dep('D2', 'dep2-3.0.jar'),
      ]),
    ],
    new Set([favoriteInstallKey('modrinth', 'D1')]),
  )
  check('已安装的依赖不下载', installedDepPlan.downloads.map((d) => d.fileName), [
    'a-1.0.jar',
    'dep2-3.0.jar',
  ])
  check('已安装的依赖仍无删除', installedDepPlan.deletions, [])

  // ---- 3. 根资源优先于依赖 ----
  // B 既是收藏成员，又是 A 的依赖：应按根资源处理，只下载一次且 isRoot=true
  const rootWins = planFavoriteFolderInstall(
    [
      mkRoot('modrinth', 'A', 'Mod A', ver('a-1.0.jar'), [dep('B', 'b-as-dep-9.9.jar')]),
      mkRoot('modrinth', 'B', 'Mod B', ver('b-1.0.jar')),
    ],
    new Set(),
  )
  check('根资源与依赖同 id 只下一次', rootWins.downloads.length, 2)
  const bItem = rootWins.downloads.find((d) => d.projectId === 'B')
  check('按根资源处理（isRoot）', bItem.isRoot, true)
  check('用的是根资源的版本', bItem.fileName, 'b-1.0.jar')
  check('依赖形态记为 duplicate', rootWins.skipped.filter((s) => s.projectId === 'B').map((s) => s.reason), [
    'duplicate',
  ])

  // ---- 4. 共享依赖只下一次，保留首次出现的版本 ----
  const sharedDep = planFavoriteFolderInstall(
    [
      mkRoot('modrinth', 'A', 'Mod A', ver('a-1.0.jar'), [dep('D1', 'dep1-from-a.jar')]),
      mkRoot('modrinth', 'B', 'Mod B', ver('b-1.0.jar'), [dep('D1', 'dep1-from-b.jar')]),
    ],
    new Set(),
  )
  const d1 = sharedDep.downloads.filter((d) => d.projectId === 'D1')
  check('共享依赖只下载一次', d1.length, 1)
  check('保留首次出现的版本', d1[0].fileName, 'dep1-from-a.jar')
  check('第二次出现记为 duplicate', sharedDep.skipped.filter((s) => s.projectId === 'D1').length, 1)

  // ---- 5. 来源隔离：同 id 不同来源互不影响 ----
  const sourceIsolated = planFavoriteFolderInstall(
    [
      mkRoot('modrinth', '123', 'MR 123', ver('mr-1.0.jar')),
      mkRoot('curseforge', '123', 'CF 123', ver('cf-1.0.jar')),
    ],
    new Set([favoriteInstallKey('modrinth', '123')]),
  )
  check('modrinth 的 123 已安装', sourceIsolated.skipped.map((s) => s.source), ['modrinth'])
  check('curseforge 的 123 仍下载', sourceIsolated.downloads.map((d) => d.fileName), ['cf-1.0.jar'])

  // ---- 6. 各种跳过原因 ----
  const reasons = planFavoriteFolderInstall(
    [
      mkRoot('modrinth', 'NO_VER', 'No Version', null),
      mkRoot('modrinth', 'NO_URL', 'No Url', { fileName: 'x.jar', url: '' }),
      mkRoot('modrinth', 'RP', 'Resource Pack', ver('rp.zip'), [], 'resourcepack'),
      mkRoot('technic', 'T1', 'Technic Mod', ver('t.jar')),
    ],
    new Set(),
  )
  check('全部跳过', reasons.downloads, [])
  check('跳过原因齐全', reasons.skipped.map((s) => s.reason).sort(), [
    'missingUrl',
    'noCompatibleVersion',
    'notMod',
    'unsupportedSource',
  ])
  check('countSkipped 统计', countSkipped(reasons, 'notMod'), 1)

  // ---- 7. 只有被采纳的根资源才带依赖进来 ----
  // 根资源无兼容版本 → 它的依赖也不该被装
  const orphanDeps = planFavoriteFolderInstall(
    [mkRoot('modrinth', 'A', 'Mod A', null, [dep('D1', 'dep1-2.0.jar')])],
    new Set(),
  )
  check('根资源无版本时依赖不进入下载', orphanDeps.downloads, [])

  // 根资源已安装 → 依赖也不带进来
  const installedRootDeps = planFavoriteFolderInstall(
    [mkRoot('modrinth', 'A', 'Mod A', ver('a-1.0.jar'), [dep('D1', 'dep1-2.0.jar')])],
    new Set([favoriteInstallKey('modrinth', 'A')]),
  )
  check('根资源已安装时依赖不进入下载', installedRootDeps.downloads, [])

  // ---- 8. 上游文件名原样透传（命名去重属于批任务的命名域）----
  const sameName = planFavoriteFolderInstall(
    [
      mkRoot('modrinth', 'A', 'Mod A', ver('same-1.0.jar')),
      mkRoot('modrinth', 'B', 'Mod B', ver('same-1.0.jar')),
    ],
    new Set(),
  )
  check(
    '同名不在此处改写（交给批任务命名阶段）',
    sameName.downloads.map((d) => d.fileName),
    ['same-1.0.jar', 'same-1.0.jar'],
  )

  // ---- 9. 依赖分类透传（光影/资源包依赖保留各自 category）----
  const catPlan = planFavoriteFolderInstall(
    [mkRoot('modrinth', 'A', 'Mod A', ver('a-1.0.jar'), [dep('S1', 'shader.zip', 'modrinth', undefined, 'shaderpacks')])],
    new Set(),
  )
  check('依赖分类透传', catPlan.downloads.find((d) => d.projectId === 'S1').category, 'shaderpacks')

  // ---- 10. 重复根资源去重 ----
  const dupRoot = planFavoriteFolderInstall(
    [
      mkRoot('modrinth', 'A', 'Mod A', ver('a-1.0.jar')),
      mkRoot('modrinth', 'A', 'Mod A again', ver('a-1.0.jar')),
    ],
    new Set(),
  )
  check('重复根资源只下一次', dupRoot.downloads.length, 1)
  check('重复根资源记为 duplicate', dupRoot.skipped.map((s) => s.reason), ['duplicate'])

  console.log(`\n✓ favoriteFolderInstallPlan: ${checks} 项断言通过`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
