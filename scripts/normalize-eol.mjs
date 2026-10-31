// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// Unix shebang 要求 LF：Windows 检出（autocrlf）会让 tsc 产物带 CRLF，
// shebang 变成 "#!/usr/bin/env node\r" → npm publish 判 bin 无效并移除。
// 以 CLI 包目录为基准归一 dist/*.js；npm script 的 cwd 即包目录。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dist = join(process.cwd(), 'dist')
for (const name of readdirSync(dist)) {
  if (!name.endsWith('.js')) continue
  const f = join(dist, name)
  const buf = readFileSync(f)
  const fixed = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
  if (Buffer.compare(buf, fixed) !== 0) {
    writeFileSync(f, fixed)
    console.log(`[normalize-eol] ${name}: CRLF → LF`)
  }
}
