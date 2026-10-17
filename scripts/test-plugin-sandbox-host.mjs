#!/usr/bin/env node
// Copyright (C) 2026 Qomicex Launcher Contributors
// SPDX-License-Identifier: GPL-3.0-or-later

// src/plugins/sandbox-host.ts 的生命周期回归（issue #260）。
//
// 为什么需要它：srcdoc iframe 只有进入文档才执行脚本。库插件没有页面宿主，若 iframe
// 只由 PluginPage 挂载，registerMethod 永不执行，依赖方 callPlugin 全部失败，而宿主
// 状态仍显示 active —— 静默失效，UI 上看不出任何异常。这里钉住三条契约：
//   1. 常驻宿主固定在 document.body 上（不在页面容器里也不会被卸载）
//   2. 进出插件页面只搬动宿主，节点本身不离开文档（moveBefore 路径）
//   3. 启用/停用循环后 body 上不残留宿主
//
// 做法沿用 test-plugin-theme-sync.mjs：用仓库自带 tsc 编译**真实源码**再断言
// （sandbox-host.ts 无 import，可独立编译）。DOM 用最小 stub 顶替。
//
// 运行：pnpm run test:plugin-sandbox-host

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'plugins', 'sandbox-host.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-sandbox-host-'))
let checks = 0

function describe(value) {
  if (value === undefined || value === null) return String(value)
  if (typeof value === 'object') return `[object ${value.constructor?.name ?? 'Object'}]${value.tagName ? ` <${value.tagName.toLowerCase()}>` : ''}`
  return JSON.stringify(value)
}

function check(name, actual, expected) {
  assert.deepEqual(
    actual,
    expected,
    `${name}\n  期望: ${describe(expected)}\n  实际: ${describe(actual)}`,
  )
  checks += 1
}

/** 节点比较用同一性，避免 FakeElement 的父子引用导致 JSON 循环。 */
function checkNode(name, actual, expected) {
  assert.equal(actual, expected, `${name}\n  期望与实际的 DOM 节点不是同一个`)
  checks += 1
}

/** 最小 DOM stub：只覆盖 sandbox-host.ts 用到的部分。 */
function installDomStub({ moveBefore = true } = {}) {
  class FakeElement {
    constructor(tag) {
      this.tagName = tag.toUpperCase()
      this.children = []
      this.parentElement = null
      this.attributes = {}
      this.dataset = {}
      this.cssText = ''
      this.style = { get cssText() { return this._css }, set cssText(v) { this._css = v } }
      this._css = ''
    }
    get isConnected() {
      let node = this.parentElement
      if (!node) return this === globalThis.document.documentElement || this === globalThis.document.body
      while (node.parentElement) node = node.parentElement
      return node === globalThis.document.documentElement
    }
    appendChild(node) {
      if (node.parentElement) node.remove()
      this.children.push(node)
      node.parentElement = this
      return node
    }
    remove() {
      if (!this.parentElement) return
      const list = this.parentElement.children
      const i = list.indexOf(this)
      if (i >= 0) list.splice(i, 1)
      this.parentElement = null
    }
    removeAttribute(name) {
      delete this.attributes[name]
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    }
    getAttribute(name) {
      return this.attributes[name] ?? null
    }
  }

  if (moveBefore) {
    FakeElement.prototype.moveBefore = function (node /*, ref */) {
      // 与浏览器一致：只有已有父节点、且同文档时才可用
      if (!node.parentElement) throw new Error('InvalidStateError: node has no parent')
      if (!node.isConnected) throw new Error('InvalidStateError: node not connected')
      node.remove()
      this.appendChild(node)
      node.movedBy = 'moveBefore'
      return undefined
    }
  }

  const body = new FakeElement('body')
  const documentElement = new FakeElement('html')
  documentElement.appendChild(body)
  globalThis.document = {
    body,
    documentElement,
    createElement: (tag) => new FakeElement(tag),
  }
  // sandbox-host 通过 Element.prototype 探测 moveBefore 是否可用
  globalThis.Element = FakeElement
  // 无 moveBefore 的路径会挂几何跟踪；stub 里给最小实现
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  }
  return { body, documentElement, FakeElement }
}

/** 递归统计某节点下 iframe 数量。 */
function iframeCount(node) {
  return node.children.reduce((n, c) => n + (c.tagName === 'IFRAME' ? 1 : 0) + iframeCount(c), 0)
}

try {
  execFileSync(
    process.execPath,
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const { body, FakeElement } = installDomStub()
  const require = createRequire(import.meta.url)
  const modulePath = join(outDir, 'sandbox-host.js')
  const exports = require(modulePath)

  /**
   * 切换 DOM stub 时必须清 require 缓存并重新加载：模块在首次加载时就绑定了当时的
   * `document`/`Element`，复用缓存会让两个 stub 的状态混在一起，断言通过不代表
   * 目标路径被验证（例如无 moveBefore 分支其实跑在旧 stub 的 document 上）。
   */
  function reloadWithStub(options) {
    installDomStub(options)
    delete require.cache[require.resolve(modulePath)]
    return require(modulePath)
  }

  // 导出契约先校验：改名/删除时报错应指向契约变化，而不是后续调用处的 TypeError
  for (const name of ['createHost', 'attachHost', 'mountHost', 'unmountHost', 'trackMountTarget', 'HIDDEN_HOST_STYLE', 'MOUNTED_HOST_STYLE']) {
    check(`导出 ${name} 存在`, name in exports, true)
  }
  check('createHost 是函数', typeof exports.createHost, 'function')

  const { createHost, attachHost, mountHost, unmountHost, HIDDEN_HOST_STYLE, MOUNTED_HOST_STYLE } = exports

  // ---- 初始态：隐藏、不可见、带插件标记 ----
  const host = createHost('top.qomicex.markdown')
  check('初始样式为隐藏态', host.style.cssText, HIDDEN_HOST_STYLE)
  check('初始 aria-hidden', host.getAttribute('aria-hidden'), 'true')
  check('宿主带插件 id 标记', host.dataset.pluginHost, 'top.qomicex.markdown')
  check('创建时未入文档', host.isConnected, false)

  // ---- 常驻挂载：进 body，即使页面容器从未出现也保持连接 ----
  attachHost(host)
  checkNode('挂载后父节点是 body', host.parentElement, body)
  check('挂载后仍在文档内', host.isConnected, true)
  check('挂载后仍隐藏', host.style.cssText, HIDDEN_HOST_STYLE)

  // ---- 页面打开：迁入页面容器，仍是同一个节点（不重建浏览上下文）----
  const page = new FakeElement('div')
  body.appendChild(page)
  mountHost(host, page)
  checkNode('迁入页面容器', host.parentElement, page)
  check('迁入后走 moveBefore', host.movedBy, 'moveBefore')
  check('迁入后显示态样式', host.style.cssText, MOUNTED_HOST_STYLE)
  check('迁入后移除 aria-hidden', host.getAttribute('aria-hidden'), null)
  check('迁入后仍在文档内', host.isConnected, true)

  // ---- 页面关闭：退回 body 隐藏位，插件脚本与已注册方法不随页面卸载 ----
  unmountHost(host)
  checkNode('退回 body', host.parentElement, body)
  check('退回后恢复隐藏态', host.style.cssText, HIDDEN_HOST_STYLE)
  check('退回后补回 aria-hidden', host.getAttribute('aria-hidden'), 'true')
  check('退回后仍在文档内', host.isConnected, true)

  // ---- 幂等：已在目标位置时重复调用不改变任何状态 ----
  unmountHost(host)
  checkNode('重复退回不改变父节点', host.parentElement, body)
  mountHost(host, page)
  mountHost(host, page)
  checkNode('重复迁入不改变父节点', host.parentElement, page)

  // ---- 没有页面宿主的插件也要有容器：宿主内 iframe 数量保持 1 ----
  const iframe = new FakeElement('iframe')
  host.appendChild(iframe)
  check('宿主内仅一个 iframe', iframeCount(host), 1)
  check('iframe 随宿主常驻文档', iframe.isConnected, true)

  // ---- 停用：宿主脱离文档，body 上不残留 ----
  host.remove()
  check('销毁后脱离文档', host.isConnected, false)
  check('销毁后 body 无宿主', body.children.includes(host), false)

  // ---- 启用/停用循环 N 次：body 上不累积宿主（泄漏的直接体现）----
  const N = 20
  for (let i = 0; i < N; i += 1) {
    const h = createHost(`plugin-${i}`)
    attachHost(h)
    mountHost(h, page)
    // 中间态校验：mount 后必须真的挂进目标容器，否则「循环结束无残留」这条断言
    // 在 mount/unmount 全坏掉时也会通过（恒为 0），起不到防护作用
    check(`第 ${i} 次 mount 后父节点是页面容器`, h.parentElement, page)
    check(`第 ${i} 次 mount 后处于显示态`, h.style.cssText, MOUNTED_HOST_STYLE)
    unmountHost(h)
    check(`第 ${i} 次 unmount 后父节点回到 body`, h.parentElement, body)
    check(`第 ${i} 次 unmount 后恢复隐藏态`, h.style.cssText, HIDDEN_HOST_STYLE)
    h.remove()
  }
  check(`${N} 次启用/停用后 body 无插件宿主残留`, body.children.filter((c) => c.dataset?.pluginHost).length, 0)

  // ---- 不支持 moveBefore（WebKit）：不搬动节点，改用固定定位覆盖；绝不重载 iframe ----
  const noMove = reloadWithStub({ moveBefore: false })
  const host2 = noMove.createHost('legacy')
  noMove.attachHost(host2)
  const page2 = globalThis.document.createElement('div')
  page2.getBoundingClientRect = () => ({ left: 64, top: 100, width: 800, height: 600 })
  globalThis.document.body.appendChild(page2)
  noMove.mountHost(host2, page2)
  checkNode('无 moveBefore 时宿主不搬家（iframe 不重载）', host2.parentElement, globalThis.document.body)
  check('无 moveBefore 时改为固定定位覆盖', host2.style.cssText.includes('position:fixed'), true)
  check('无 moveBefore 时对齐容器几何', host2.style.cssText.includes('left:64px') && host2.style.cssText.includes('width:800px'), true)
  check('无 moveBefore 时可见', host2.getAttribute('aria-hidden'), null)
  noMove.unmountHost(host2)
  checkNode('无 moveBefore 时退回隐藏位仍是同一父节点', host2.parentElement, globalThis.document.body)
  check('无 moveBefore 时恢复隐藏样式', host2.style.cssText, HIDDEN_HOST_STYLE)

  console.log(`\n[test-plugin-sandbox-host] OK — ${checks} 项断言通过`)
} catch (err) {
  console.error(`\n[test-plugin-sandbox-host] FAILED\n${err?.message ?? err}`)
  process.exitCode = 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
