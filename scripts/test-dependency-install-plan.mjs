#!/usr/bin/env node
// src/lib/dependencyInstallPlan.ts 的回归测试（issue #249）。
//
// 为什么不是一个测试框架：AGENTS.md「无前端单测框架」一节把测试框架的引入排在后面，
// 而这里要锁的是一条**破坏性行为**的契约——「已安装的前置绝不能被删」。它此前写在
// ResourceInstallDialog 的 useCallback 里，只能靠人读代码发现，线上表现为「前置被删光
// 且不补下载」。做法沿用 test-update-channel.mjs / test-deep-link-parse.mjs：
// 用仓库自带的 tsc 编译**真实源码**到临时目录再断言，不引入新依赖，也不抄一份逻辑自证。
//
// 运行：pnpm run test:dependency-install-plan
//
// 守的回归（对应 issue #249 根因）：
//   已安装判定用远程 projectId，而"是否要替换"曾拿本地文件名 `existing.fileName`
//   与上游文件名 `dep.fileName` 比较。本地名经命名模板（[{cn}]{name}-{version}，
//   ENH-10）变成 `[Fabric-API]Fabric-API-0.162.0+26.3.jar`，上游名是
//   `fabric-api-0.162.0+26.3.jar` —— 两个命名域必然不等，于是每个已安装的前置都被
//   塞进删除名单，同时下载分支被 continue 跳过：删完不补。
//   下面第 1、2 条断言用**真实 incident 数据**（本机 mods 缓存里 fabric-api 的本地名）
//   钉住这个形状。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'lib', 'dependencyInstallPlan.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-dep-plan-'))
let checks = 0

/** 断言 helper：失败时打印可读的 expected/actual，而不是只抛一个 assert 栈。 */
function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
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
  const { planDependencyInstall } = require(join(outDir, 'dependencyInstallPlan.js'))

  // 真实 incident 数据（issue #249）：日志 URL 里的上游原名，与本机 mods 目录里
  // 经命名模板重命名后的本地名。这两个字符串**必须**不同，否则本测试就守不住那个坑。
  const UPSTREAM_NAME = 'fabric-api-0.162.0+26.3.jar'
  const LOCAL_NAME = '[Fabric-API]Fabric-API-0.162.0+26.3.jar'
  assert.notEqual(UPSTREAM_NAME, LOCAL_NAME, '本地名与上游名应不同域（命名模板生效）')

  const installedFabricApi = {
    projectId: 'P7dR8mSH',
    name: 'Fabric API',
    iconUrl: '',
    versionId: 'SKW1BTL3',
    versionNumber: '0.162.0+26.3',
    downloadUrl:
      'https://cdn.modrinth.com/data/P7dR8mSH/versions/SKW1BTL3/fabric-api-0.162.0%2B26.3.jar',
    fileName: UPSTREAM_NAME,
    category: 'mods',
    source: 'modrinth',
  }

  const installedMap = new Map([['P7dR8mSH', { fileName: LOCAL_NAME, version: '0.162.0+26.3' }]])

  // ---- 1. 已安装的前置：不重下、不删除（issue #249 的核心契约）----
  const installedPlan = planDependencyInstall([installedFabricApi], installedMap)
  check('已安装的前置不下载', installedPlan.downloads, [])
  check('已安装的前置不删除', installedPlan.deletions, [])

  // ---- 2. 旧写法（本地名 !== 上游名 → 删）必须不再产生任何删除 ----
  // 显式复现旧判据：若回归到文件名比较，下面这个真值会把它变成一条删除记录。
  const wouldOldLogicDelete = LOCAL_NAME !== UPSTREAM_NAME
  assert.equal(wouldOldLogicDelete, true, '旧判据在此数据上恒为 true（这正是根因）')
  check(
    '本地名与上游名不同也不进删除名单',
    planDependencyInstall([installedFabricApi], installedMap).deletions,
    [],
  )

  // ---- 3. 未安装的前置：正常进入下载 ----
  const missingDep = {
    projectId: 'Ha28R6CL',
    name: 'Fabric Language Kotlin',
    iconUrl: '',
    versionId: 'SKW1BTL3',
    versionNumber: '1.14.2+kotlin.2.4.21',
    downloadUrl:
      'https://cdn.modrinth.com/data/Ha28R6CL/versions/SKW1BTL3/fabric-language-kotlin-1.14.2%2Bkotlin.2.4.21.jar',
    fileName: 'fabric-language-kotlin-1.14.2+kotlin.2.4.21.jar',
    category: 'mods',
    source: 'modrinth',
  }
  const mixedPlan = planDependencyInstall([installedFabricApi, missingDep], installedMap)
  check('未安装的前置进入下载', mixedPlan.downloads.length, 1)
  check('下载的是未安装的那个', mixedPlan.downloads[0].fileName, missingDep.fileName)
  check('混合场景仍无删除', mixedPlan.deletions, [])

  // ---- 4. 用户在依赖版本选择器里的覆盖仍生效（防修复误伤）----
  const overridden = planDependencyInstall([missingDep], new Map(), {
    Ha28R6CL: {
      downloadUrl: 'https://cdn.modrinth.com/data/Ha28R6CL/versions/OTHER/x.jar',
      fileName: 'picked.jar',
    },
  })
  check('用户选定的版本被采用', overridden.downloads[0].fileName, 'picked.jar')
  check(
    '用户选定的 URL 被采用',
    overridden.downloads[0].url,
    'https://cdn.modrinth.com/data/Ha28R6CL/versions/OTHER/x.jar',
  )

  // ---- 5. 无 URL 的依赖不伪造下载任务 ----
  check(
    '缺下载 URL 的依赖被跳过',
    planDependencyInstall([{ ...missingDep, downloadUrl: '' }], new Map()).downloads,
    [],
  )

  // ---- 6. 非 mods 分类（光影/资源包依赖）保留各自 category ----
  const shaderDep = { ...missingDep, projectId: 'shader1', category: 'shaderpacks' }
  check(
    '分类透传',
    planDependencyInstall([shaderDep], new Map()).downloads[0].category,
    'shaderpacks',
  )

  console.log(`\n✓ dependencyInstallPlan: ${checks} 项断言通过`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
