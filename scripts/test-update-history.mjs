#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/lib/updateHistory.ts 的回归测试。
//
// 与 test-update-channel.mjs 同一路子：用仓库自带的 tsc 把**真实源码**编译到
// 临时目录再断言，不引入测试框架、也不把逻辑抄一份到测试里自证。
//
// 运行：pnpm run test:update-history   （CI 的 frontend-lint 作业跑同一条命令）
//
// 守的回归：
//   1. generate-changelog.mjs 的固定输出格式（`#### ✨ 新增功能` + `- 条目`）
//      必须能被解析成分类条目——这批文案是 issue #357 的展示主体；
//   2. 解析失败时必须返回 null（调用方据此退回整段 markdown 渲染），
//      绝不能返回空数组——那会让弹窗出现一个空白面板；
//   3. 折叠切分（默认展开 3 个版本）与 `truncated` 语义；
//   4. `vv1.2.0` 之类的前缀不得渲染成重复的 `v`。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'lib', 'updateHistory.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-update-history-'))
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
  const {
    parseNotes,
    splitVisibleVersions,
    displayVersion,
    categoryLabelKey,
    pickSpanningEntries,
    DEFAULT_VISIBLE_VERSIONS,
  } = require(join(outDir, 'updateHistory.js'))

  // ---- parseNotes：生成器真实产物 ----
  {
    // generate-changelog.mjs 的 formatChangelog 输出（含 emoji 与分隔线）
    const notes = [
      '## Qomicex Launcher 1.2.0-beta1.0',
      '',
      '**Beta 版本**',
      '',
      '---',
      '',
      '#### ✨ 新增功能',
      '',
      '- macOS .app 提权改用 osascript 管理员授权 (#204) (#353)',
      '- 商店安装自动补齐必装前置依赖',
      '',
      '#### 🐛 修复',
      '',
      '- 资源列表追加分页时只动画新增项 (#355) (#356)',
      '',
      '#### ⚡ 性能优化',
      '',
      '- 骨架占位改为 shimmer 高光扫过',
      '',
      '#### 🔧 重构',
      '',
      '- 合并前自查修复',
    ].join('\n')

    const parsed = parseNotes(notes)
    assert.ok(parsed, '生成器格式必须能解析')
    assert.equal(parsed.entries.length, 5, '必须收齐全部条目')
    assert.deepEqual(
      parsed.entries.map((e) => e.category),
      ['feat', 'feat', 'fix', 'perf', 'refactor'],
      '分类必须按标题映射，不能全部落进 other',
    )
    assert.equal(parsed.entries[0].text, 'macOS .app 提权改用 osascript 管理员授权 (#204) (#353)')
    // 引用号必须原样保留（UI 只弱化颜色，不删信息）
    assert.ok(parsed.entries[0].text.includes('(#204)'), '引用号不得被剥离')
    checks++
  }

  // ---- 无 emoji 的标题同样识别（上游哪天去掉 emoji 不能全变 other）----
  {
    const parsed = parseNotes('#### 新增功能\n\n- 一条\n\n#### 修复\n\n- 另一条')
    assert.ok(parsed)
    assert.deepEqual(parsed.entries.map((e) => e.category), ['feat', 'fix'])
    checks++
  }

  // ---- 未知分类：保留内容并归到 other，不丢弃 ----
  {
    const parsed = parseNotes('#### 🎉 杂项\n\n- 保留我')
    assert.ok(parsed)
    assert.equal(parsed.entries[0].category, 'other')
    assert.equal(parsed.entries[0].text, '保留我')
    checks++
  }

  // ---- 缩进续行并回上一条 ----
  {
    const parsed = parseNotes('#### 修复\n\n- 第一行\n  第二行')
    assert.ok(parsed)
    assert.equal(parsed.entries.length, 1)
    assert.ok(parsed.entries[0].text.includes('第一行'))
    assert.ok(parsed.entries[0].text.includes('第二行'))
    checks++
  }

  // ---- 解析失败返回 null（调用方退回 markdown 原文）----
  {
    assert.equal(parseNotes(''), null, '空 notes → null')
    assert.equal(parseNotes('   \n  '), null, '空白 notes → null')
    assert.equal(
      parseNotes('## 某版本\n\n就是一段说明，没有分类标题'),
      null,
      '无分类标题 → null（不得返回空数组，否则弹窗空白）',
    )
    assert.equal(
      parseNotes('#### ✨ 新增功能\n\n（这一版只有一句话，没有列表条目）'),
      null,
      '有标题但零条目 → null',
    )
    checks++
  }

  // ---- 折叠切分 ----
  {
    const many = Array.from({ length: 8 }, (_, i) => `v${i}`)
    const { visible, older } = splitVisibleVersions(many)
    assert.equal(visible.length, DEFAULT_VISIBLE_VERSIONS)
    assert.equal(DEFAULT_VISIBLE_VERSIONS, 3, '参考设计：默认展开 3 个版本段')
    assert.equal(older.length, 5)
    assert.deepEqual(visible, ['v0', 'v1', 'v2'], '必须是最新的在前')

    // 不足默认数量：没有折叠区（否则会渲染一个「还有 0 个」的死入口）
    const few = splitVisibleVersions(['v1', 'v0'])
    assert.equal(few.older.length, 0)
    assert.equal(few.visible.length, 2)

    const empty = splitVisibleVersions([])
    assert.equal(empty.older.length, 0)
    checks++
  }

  // ---- 版本号展示 ----
  {
    assert.equal(displayVersion('1.2.0-beta1.0'), 'v1.2.0-beta1.0')
    assert.equal(displayVersion('v1.2.0-beta1.0'), 'v1.2.0-beta1.0', '不得出现 vv')
    assert.equal(displayVersion('vv1.2.0'), 'v1.2.0')
    assert.equal(displayVersion(''), '')
    assert.equal(displayVersion('  '), '')
    checks++
  }

  // ---- 分类 → i18n key ----
  {
    assert.equal(categoryLabelKey('feat'), 'dialogs.update.category.feat')
    assert.equal(categoryLabelKey('fix'), 'dialogs.update.category.fix')
    assert.equal(categoryLabelKey('refactor'), 'dialogs.update.category.refactor')
    assert.equal(categoryLabelKey('perf'), 'dialogs.update.category.perf')
    assert.equal(categoryLabelKey('other'), 'dialogs.update.category.other')
    checks++
  }

  // ---- pickSpanningEntries：该不该走跨版本视图 ----
  {
    const entries = [{ version: '1.2.0-beta2.0' }, { version: '1.2.0-beta1.0' }]

    // spanning=false（只命中一条）→ 退回单块渲染，即使有 entries
    assert.equal(
      pickSpanningEntries({ spanning: false, entries }, '1.2.0-beta2.0'),
      null,
      '只跨一个版本时不该用跨版本视图',
    )
    // 空 entries → 退回
    assert.equal(pickSpanningEntries({ spanning: true, entries: [] }, '1.2.0-beta2.0'), null)
    // spanning=true 且目标在列表里 → 使用
    assert.equal(
      pickSpanningEntries({ spanning: true, entries }, '1.2.0-beta2.0')?.length,
      2,
    )
    // 目标不在列表里 → 退回单块，否则用户看不到自己要装的那版
    assert.equal(
      pickSpanningEntries({ spanning: true, entries }, '1.2.0-beta9.0'),
      null,
      '目标版本不在历史里时必须退回单块 changelog',
    )
    // target 缺失 → 不做该检查，直接用
    assert.equal(pickSpanningEntries({ spanning: true, entries }, undefined)?.length, 2)
    assert.equal(pickSpanningEntries({ spanning: true, entries }, '')?.length, 2)
    // v 前缀两侧都要归一
    assert.equal(
      pickSpanningEntries({ spanning: true, entries }, 'v1.2.0-beta2.0')?.length,
      2,
    )
    assert.equal(
      pickSpanningEntries(
        { spanning: true, entries: [{ version: 'v1.2.0-beta2.0' }] },
        '1.2.0-beta2.0',
      )?.length,
      1,
    )
    checks++
  }

  console.log(`test-update-history: ${checks} 组断言全部通过`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
