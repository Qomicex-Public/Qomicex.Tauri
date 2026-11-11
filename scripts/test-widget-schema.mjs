#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/pages/dashboard/custom/schema.ts 的回归测试。
//
// 守的边界：绑定路径不得穿透原型链、缺失绑定必须为空串、只允许 https:443、
// XML 预检拒绝 DOCTYPE/ENTITY 与超限内容、自动出网域名收集按白名单去重。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'pages', 'dashboard', 'custom', 'schema.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-widget-schema-'))
let checks = 0

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${JSON.stringify(expected)}\n  实际: ${JSON.stringify(actual)}`,
  )
  checks += 1
}

function throwsCode(name, fn, code) {
  try {
    fn()
  } catch (e) {
    check(`${name} 抛 ${code}`, e.code, code)
    return
  }
  assert.fail(`${name} 未抛错`)
}

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2022', '--skipLibCheck', '--allowImportingTsExtensions', '--rewriteRelativeImportExtensions'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const schema = require(join(outDir, 'schema.js'))

  // ---- 绑定路径 ----
  const scope = { news: { title: 'T', items: [{ name: 'a' }, { name: 'b' }] }, index: 1 }
  check('嵌套对象/数组路径', schema.resolvePath(scope, 'news.items.1.name'), 'b')
  check('带花括号路径', schema.resolvePath(scope, '{news.title}'), 'T')
  check('缺失路径为 undefined', schema.resolvePath(scope, 'news.missing'), undefined)
  check('原型链不可穿透', schema.resolvePath({}, 'constructor'), undefined)
  check('__proto__ 不可穿透', schema.resolvePath({}, '__proto__.polluted'), undefined)
  check('数组非数字下标', schema.resolvePath(scope, 'news.items.x'), undefined)
  check('基础值继续取属性', schema.resolvePath({ a: 1 }, 'a.b'), undefined)

  // ---- 插值 ----
  check('插值替换', schema.interpolate('{news.title} / {index}', scope), 'T / 1')
  check('未命中为空串', schema.interpolate('x{missing}y', scope), 'xy')
  check('对象插值为 JSON', schema.interpolate('{a}', { a: { b: 1 } }), '{"b":1}')
  check('字符串原样', schema.interpolate('{a}', { a: 'x' }), 'x')
  check(
    '深度插值保留类型',
    schema.interpolateDeep({ age: '{in.age}', name: 'x-{in.name}', nested: ['{in.age}'] }, { in: { age: 18, name: 'A' } }),
    { age: 18, name: 'x-A', nested: [18] },
  )

  const converterList = [
    { name: 'Money', type: 'Format', format: 'N2' },
    { name: 'Visible', type: 'BoolToVisibility' },
    { name: 'Label', type: 'Map', map: [{ from: 'True', to: '开' }, { from: 'False', to: '关' }] },
    { name: 'Join', type: 'Join' },
    { name: 'Double', type: 'Script', convertScript: 'return Number(value) * 2' },
  ]
  check(
    'Binding 单值 Converter',
    schema.interpolate('{Binding price, Converter=Money}', { price: 12.3 }, { converters: converterList, locale: 'en-US' }),
    '12.30',
  )
  check(
    'Binding 参数覆盖',
    schema.interpolate('{Binding price, Converter=Money, ConverterParameter="N1"}', { price: 12.34 }, { converters: converterList, locale: 'en-US' }),
    '12.3',
  )
  check(
    'Binding BoolToVisibility',
    schema.interpolate('{Binding flag, Converter=Visible}', { flag: true }, { converters: converterList }),
    'Visible',
  )
  check(
    'Binding Map 布尔大小写',
    schema.interpolate('{Binding flag, Converter=Label}', { flag: true }, { converters: converterList }),
    '开',
  )
  check(
    'MultiBinding Join',
    schema.interpolate('{MultiBinding Paths="first|last", Converter=Join, ConverterParameter=" "}', { first: 'A', last: 'B' }, { converters: converterList }),
    'A B',
  )
  check(
    'Binding 脚本 Converter',
    schema.interpolate('{Binding price, Converter=Double}', { price: 4 }, { converters: converterList }),
    '8',
  )
  check(
    '精确 Binding 保留类型',
    schema.interpolateDeep('{Binding price, Converter=Double}', { price: 4 }, { converters: converterList }),
    8,
  )

  // ---- URL ----
  check('https 允许', schema.isSafeHttpsUrl('https://example.com/a'), true)
  check('https:443 允许', schema.isSafeHttpsUrl('https://example.com:443/a'), true)
  check('http 拒绝', schema.isSafeHttpsUrl('http://example.com/a'), false)
  check('非 443 拒绝', schema.isSafeHttpsUrl('https://example.com:8443/a'), false)
  check('用户信息拒绝', schema.isSafeHttpsUrl('https://u:p@example.com/a'), false)
  check('localhost 拒绝', schema.isSafeHttpsUrl('https://localhost/a'), false)
  check('.local 拒绝', schema.isSafeHttpsUrl('https://a.local/a'), false)
  check('hostOf 小写', schema.hostOf('https://EXAMPLE.com/a'), 'example.com')
  check('hostOf 拒绝 http', schema.hostOf('http://example.com/a'), null)

  // ---- XML 预检 ----
  throwsCode('空 XML', () => schema.assertSafeXml('   '), 'xmlEmpty')
  throwsCode('DOCTYPE', () => schema.assertSafeXml('<!DOCTYPE x><Widget/>'), 'xmlDoctype')
  throwsCode('ENTITY', () => schema.assertSafeXml('<!ENTITY x "y"><Widget/>'), 'xmlDoctype')
  throwsCode('超过 256KB', () => schema.assertSafeXml(`<Widget>${'a'.repeat(256 * 1024)}</Widget>`), 'xmlTooLarge')
  schema.assertSafeXml('<Widget Name="x" Version="1"/>')
  checks += 1

  // ---- 域名收集 ----
  check(
    '自动出网域名去重排序',
    schema.collectAutoHosts({
      datas: [
        { name: 'A', type: 'Json', source: 'Url', url: 'https://b.example/x', refresh: 60 },
        { name: 'B', type: 'Json', source: 'Url', url: 'https://a.example/x', refresh: 60 },
        { name: 'C', type: 'Text', source: 'File', path: 'C:/x.txt', refresh: 60 },
      ],
      updateUrl: 'https://b.example/widget.qwidget',
      staticMediaUrls: ['https://img.example/a.png', '{State.dynamic}', 'https://a.example/a.png'],
      nestedUrls: ['https://nested.example/w.qwidget'],
    }),
    ['a.example', 'b.example', 'img.example', 'nested.example'],
  )

  // ---- 本地路径 ----
  check('本地路径相对路径', schema.resolveLocalPath('./a/b.png', 'C:/widgets'), 'C:/widgets/a/b.png')
  check('本地绝对路径', schema.resolveLocalPath('C:/music/a.mp3', 'C:/widgets'), 'C:/music/a.mp3')
  check('别名清洗', schema.sanitizeAlias('天气卡片'), '____')
  check('别名数字开头', schema.sanitizeAlias('1abc'), '_1abc')

  // ---- 版本要求 ----
  check('版本格式 1.2', schema.isVersionRequirement('1.2'), true)
  check('版本格式 1.2.3-beta', schema.isVersionRequirement('1.2.3-beta'), true)
  check('版本格式非法', schema.isVersionRequirement('latest'), false)
  check('版本比较 1.2 < 1.3', schema.compareVersions('1.2', '1.3') < 0, true)
  check('版本比较 1.2.0 == 1.2', schema.compareVersions('1.2.0', '1.2'), 0)
  check('版本比较 2.0 > 1.9.9', schema.compareVersions('2.0', '1.9.9') > 0, true)
  check('版本预发布低于正式版', schema.compareVersions('1.2.0-beta', '1.2.0') < 0, true)

  // ---- ContentProperty ----
  check('Text ContentProperty', schema.CONTENT_PROPERTY.Text, 'Value')
  check('Button ContentProperty', schema.CONTENT_PROPERTY.Button, 'Text')
  check('Media ContentProperty', schema.CONTENT_PROPERTY.Media, 'Source')
  check('Container 无标量 ContentProperty', schema.CONTENT_PROPERTY.Container, undefined)

  // ---- 标识符 ----
  schema.validateIdentifier('newsData', 'test')
  schema.validateIdentifier('a-b', 'test')
  throwsCode('数字开头标识符', () => schema.validateIdentifier('1a', 'test'), 'invalidName')
  throwsCode('点号标识符', () => schema.validateIdentifier('a.b', 'test'), 'invalidName')

  // ---- 动作/导航表完整性 ----
  for (const name of schema.ACTION_NAMES) {
    assert.ok(Array.isArray(schema.ACTION_ARGS[name]), `${name} 缺少 ACTION_ARGS`)
    assert.ok(Array.isArray(schema.ACTION_REQUIRED[name]), `${name} 缺少 ACTION_REQUIRED`)
    checks += 1
  }
  for (const target of schema.NAV_TARGETS) {
    assert.ok(schema.NAV_PATHS[target]?.startsWith('/'), `${target} 缺少路径`)
    checks += 1
  }

  console.log(`\n✓ widget-schema: ${checks} 项断言通过`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
