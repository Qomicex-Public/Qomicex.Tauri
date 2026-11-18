#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/lib/modDependencies.ts 的回归测试（issue #363）。
//
// 信雅互联（Sinytra Connector）允许 Forge/NeoForge 实例加载 Fabric 模组，但这些模组
// 声明的 `fabric-api` / `fabric-*-v1` 在 FFAPI 侧是下划线命名（`fabric_api` /
// `fabric_*_v1`），按原样比较会把整片 Fabric 依赖误报成缺失。这里锁住四件事：
// 有 Connector 时归一后不再误报、没有 Connector 时不放行、真实缺失仍要报、旧版
// `connectormod` id 同样生效。
//
// 与 test-deep-link-parse.mjs 一致：用仓库自带的 tsc 编译真实源码到临时目录再断言，
// 不依赖 Node 的类型剥离（package.json 声明 Node >=22，22.0~22.17 未默认启用）。
//
// 运行：pnpm run test:mod-deps

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'lib', 'modDependencies.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const outDir = mkdtempSync(join(tmpdir(), 'qmx-mod-deps-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

/** 构造一条模组元数据；只填依赖检测用到的字段。 */
function mod(fileName, modId, dependencies = [], providesIds = [], active = true) {
  return {
    fileName,
    name: fileName,
    version: '1.0.0',
    description: '',
    authors: [],
    active,
    modId,
    dependencies,
    providesIds,
  }
}

const dep = (modId) => ({ modId })

/** Map<fileName, ModDependency[]> → { fileName: modId[] }，便于断言。 */
function missingOf(mods, loader = 'forge') {
  const out = {}
  for (const [file, deps] of computeMissingDependencies(mods, loader)) {
    out[file] = deps.map((d) => d.modId)
  }
  return out
}

let computeMissingDependencies

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  writeFileSync(join(outDir, 'package.json'), '{"type":"commonjs"}')
  ;({ computeMissingDependencies } = createRequire(import.meta.url)(
    // 带 `import type ../types` 时 tsc 的公共根变成 src，产物会落在 lib/ 下。
    existsSync(join(outDir, 'modDependencies.js'))
      ? join(outDir, 'modDependencies.js')
      : join(outDir, 'lib', 'modDependencies.js'),
  ))

  const fabricMod = mod('coolmod.jar', 'coolmod', [
    dep('fabric-api'),
    dep('fabric'),
    dep('fabric-lifecycle-events-v1'),
    dep('minecraft'),
    dep('fabricloader'),
  ])
  const ffapi = mod('fabric-api.jar', 'fabric_api', [], ['fabric_lifecycle_events_v1'])
  const connector = mod('connector.jar', 'connector')

  check('Connector + FFAPI 不误报', missingOf([connector, ffapi, fabricMod]), {})
  check('connectormod 同样生效', missingOf([mod('connector.jar', 'connectormod'), ffapi, fabricMod]), {})

  check('无 Connector 仍报缺失', missingOf([ffapi, fabricMod]), {
    'coolmod.jar': ['fabric-api', 'fabric', 'fabric-lifecycle-events-v1'],
  })

  check('禁用 Connector 不放行', missingOf([mod('connector.jar', 'connector', [], [], false), ffapi, fabricMod]), {
    'coolmod.jar': ['fabric-api', 'fabric', 'fabric-lifecycle-events-v1'],
  })

  check('Fabric 加载器不启用 Connector 归一', missingOf([connector, ffapi, fabricMod], 'fabric'), {
    'coolmod.jar': ['fabric-api', 'fabric', 'fabric-lifecycle-events-v1'],
  })

  const needsCreate = mod('addon.jar', 'addon', [dep('fabric-api'), dep('create')])
  check('真实缺失仍报', missingOf([connector, ffapi, needsCreate]), {
    'addon.jar': ['create'],
  })

  const needsUnknownModule = mod('unknown.jar', 'unknown', [dep('fabric-unknown-api-v9')])
  check('未提供的子模块仍报', missingOf([connector, ffapi, needsUnknownModule]), {
    'unknown.jar': ['fabric-unknown-api-v9'],
  })

  // 归一后的 id 必须由 FFAPI 自己提供；别的模组恰好声明了同名下划线 id 不能算。
  const unrelatedProvider = mod('unrelated.jar', 'unrelated_mod', [], ['fabric_other_api_v1'])
  const needsOtherFabric = mod('needs-other.jar', 'needs_other', [dep('fabric-other-api-v1')])
  check(
    '非 FFAPI 提供的下划线 id 不放行',
    missingOf([connector, ffapi, unrelatedProvider, needsOtherFabric]),
    { 'needs-other.jar': ['fabric-other-api-v1'] },
  )

  const needsOther = mod('other.jar', 'other', [dep('my-mod')])
  check('非 fabric 前缀不归一', missingOf([connector, mod('mymod.jar', 'my_mod'), needsOther]), {
    'other.jar': ['my-mod'],
  })
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

console.log(`mod dependencies: ${checks} checks passed`)
