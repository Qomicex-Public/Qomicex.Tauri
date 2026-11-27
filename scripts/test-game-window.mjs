#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/lib/gameWindow.ts 的换算回归：预设尺寸、16:9 收窄、跟随全局的取值优先级。
// 沿用 test-download-format.mjs 的模式：tsc 编译真实源码到临时目录，不抄一份逻辑自证。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'lib', 'gameWindow.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-game-window-'))
let checks = 0

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
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const { fitSixteenByNine, pickGameWindow, gameWindowArgs } = require(join(outDir, 'gameWindow.js'))

  const screen = { width: 2560, height: 1440 }
  check('未设置不传参数', gameWindowArgs({ mode: null }, screen), {})
  check('默认固定 854×480', gameWindowArgs({ mode: 'default' }, screen), {
    windowWidth: 854,
    windowHeight: 480,
  })
  check('全屏忽略宽高', gameWindowArgs({ mode: 'fullscreen', width: 1, height: 1 }, screen), {
    windowFullscreen: true,
  })
  check('自定义宽高原样使用', gameWindowArgs({ mode: 'custom', width: 1600, height: 900 }, screen), {
    windowWidth: 1600,
    windowHeight: 900,
  })
  check('自定义缺值不传参数', gameWindowArgs({ mode: 'custom', width: 1600, height: null }, screen), {})
  check('未知模式不传参数', gameWindowArgs({ mode: 'huge' }, screen), {})

  check('小 = 屏幕宽度 50%', gameWindowArgs({ mode: 'small' }, screen), {
    windowWidth: 1280,
    windowHeight: 720,
  })
  check('中 = 屏幕宽度 70%', gameWindowArgs({ mode: 'medium' }, screen), {
    windowWidth: 1792,
    windowHeight: 1008,
  })
  check('大 = 屏幕宽度 90%', gameWindowArgs({ mode: 'large' }, screen), {
    windowWidth: 2304,
    windowHeight: 1296,
  })

  // 16:9 高度超过屏幕时按高度收窄。
  check('超出屏幕高度时按高度反算', fitSixteenByNine(1000, 400, 0.9), { width: 711, height: 400 })

  check('实例未设置时跟随全局', pickGameWindow({}, { mode: 'medium' }), { mode: 'medium' })
  check(
    '实例自定义宽高优先',
    pickGameWindow(
      { mode: 'custom', width: 1024, height: 600 },
      { mode: 'custom', width: 1920, height: 1080 },
    ),
    { mode: 'custom', width: 1024, height: 600 },
  )
  check(
    '实例自定义缺一项时不回落全局（不传参数）',
    pickGameWindow({ mode: 'custom', width: 1024 }, { mode: 'custom', width: 1920, height: 1080 }),
    { mode: null },
  )
  check('都没有设置则无参数', pickGameWindow({}, {}), { mode: null })

  console.log(`\n✓ game-window: ${checks} 项断言通过`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
