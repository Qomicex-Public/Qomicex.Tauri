#!/usr/bin/env node
// src/lib/updateChannel.ts 的回归测试。
//
// 为什么不是一个测试框架：AGENTS.md「前端无测试框架」一节把测试框架的引入排在阶段 4，
// 而这里只需要锁住**一条前后端契约**——版本前缀的大小写语义（见 ADR-085 v1.2）。
// 做法是用仓库自带的 tsc 把**真实源码**编译到临时目录再断言，所以增删都不依赖新依赖，
// 也不会出现「把逻辑抄一份到测试里自证」的问题。
//
// 运行：pnpm run test:update-channel   （CI 的 frontend-lint 作业跑同一条命令）
//
// 守的回归：
//   `replace(/^v+/i, '')` 把**大写** `V` 一起剥掉 → `V1.0.0-beta1.0` 前端判 beta，
//   而后端 `strip_v`（services/update_channel.rs，`trim_start_matches('v')`）只剥小写、
//   核心段 `V1.0.0` 非数字 → 判 Unknown。同一版本两侧通道不一致。
//   下面 `V1.0.0-beta1.0` / `Vv1.0.0-beta1.0` 两条断言就是这道防线。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'lib', 'updateChannel.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-update-channel-'))
let checks = 0

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
  const { trainOf, channelLabelKey } = require(join(outDir, 'updateChannel.js'))

  // ---- trainOf：版本号 → 发布列车（与后端 train_of 逐条对齐）----
  const trainCases = [
    // 大小写契约（本文件守护的核心）
    ['V1.0.0-beta1.0', 'unknown'],
    ['Vv1.0.0-beta1.0', 'unknown'],
    ['vv1.0.0-beta1.0', 'beta'],
    // 正常形态
    ['v0.1.0-beta10.0', 'beta'],
    ['0.1.0-release1.0', 'release'],
    ['0.1.0-beta31.0', 'beta'],
    ['0.1.0-alpha20260823.0', 'alpha'],
    ['0.1.0-alpha260719.build3', 'alpha'],
    // 类型段大小写不敏感（后端 parse_type_segment 会 to_ascii_lowercase）
    ['0.1.0-BETA1.0', 'beta'],
    // 裸版本 = 本地构建
    ['0.1.0', 'dev'],
    // 无法识别
    ['', 'unknown'],
    ['v', 'unknown'],
    ['1.0.x', 'unknown'],
    ['0.1.0-rc2', 'unknown'],
  ]
  for (const [input, want] of trainCases) {
    assert.equal(trainOf(input), want, `trainOf(${JSON.stringify(input)}) 应为 ${want}`)
    checks += 1
  }

  // ---- channelLabelKey：后端 Train::as_str() 口径 → i18n key ----
  const labelCases = [
    ['release', 'settings.about.stable'],
    ['beta', 'settings.about.beta'],
    ['alpha', 'settings.about.alpha'],
    ['dev', 'settings.about.devBuild'],
    // 认不出就不猜，由调用方回落原始字符串
    ['nope', undefined],
    [undefined, undefined],
  ]
  for (const [input, want] of labelCases) {
    assert.equal(channelLabelKey(input), want, `channelLabelKey(${JSON.stringify(input)})`)
    checks += 1
  }

  console.log(`✅ updateChannel: ${checks} 条断言全部通过`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
