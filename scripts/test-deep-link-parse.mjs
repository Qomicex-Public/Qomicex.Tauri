#!/usr/bin/env node
// src/lib/deepLink.ts 的回归测试（issue #127）。
//
// 为什么不是一个测试框架：AGENTS.md「前端无测试框架」一节把测试框架的引入排在阶段 4，
// 而这里要锁的是**安全边界**与**唯一性判定**——路径穿越能否绕过路由白名单、非法编码会不会
// 抛异常打断批处理、同名实例会不会被静默随便挑一个。这些退化都没人会在 UI 上立刻发现，
// 必须钉住。
//
// 做法与 test-update-channel.mjs 保持一致：**用仓库自带的 tsc 把真实源码编译到临时目录
// 再断言**。不用 Node 的类型剥离（`node xx.ts`）跑 `.ts`，否则要 Node ≥22.18 才默认启用，
// 而 package.json 声明的是 >=22——22.0~22.17 的开发者会在断言执行前就失败。
//
// 运行：pnpm run test:deep-link   （CI 的 frontend-lint 作业跑同一条命令）

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'lib', 'deepLink.ts')
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')

const outDir = mkdtempSync(join(tmpdir(), 'qmx-deep-link-'))
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
    [tsc, source, '--outDir', outDir, '--module', 'commonjs', '--target', 'es2020', '--skipLibCheck'],
    { stdio: 'inherit' },
  )
  const require = createRequire(import.meta.url)
  const { parseDeepLink, isAllowedRoute, isTrustedInstallUrl, splitLaunchTarget, matchLaunchTarget, DEEP_LINK_SCHEME } =
    require(join(outDir, 'deepLink.js'))

  const S = `${DEEP_LINK_SCHEME}://`

  // ---- 正常解析（防修复误伤）----
  check('open 根路径', parseDeepLink(`${S}open/`), { kind: 'open', route: '/' })
  check('open 白名单页', parseDeepLink(`${S}open/settings`), { kind: 'open', route: '/settings' })
  check('open 子路径', parseDeepLink(`${S}open/instances/abc`), { kind: 'open', route: '/instances/abc' })
  check('launch（纯名字）', parseDeepLink(`${S}launch/1.20.1-Forge`), {
    kind: 'launch',
    target: '1.20.1-Forge',
    dir: undefined,
    raw: '1.20.1-Forge',
  })
  check('launch（目录:名字）', parseDeepLink(`${S}launch/C%3A%5Cmc%5Cinst%3AMyPack`), {
    kind: 'launch',
    target: 'MyPack',
    dir: 'C:\\mc\\inst',
    raw: 'C:\\mc\\inst:MyPack',
  })
  check('join', parseDeepLink(`${S}join/482913`), { kind: 'join', code: '482913' })
  check('install plugin slug', parseDeepLink(`${S}install/plugin?slug=a.b`), {
    kind: 'installPlugin',
    slug: 'a.b',
    version: undefined,
    url: undefined,
  })
  check('install modpack', parseDeepLink(`${S}install/modpack?type=mr&projectId=P&fileId=F`), {
    kind: 'installModpack',
    source: 'modrinth',
    projectId: 'P',
    fileId: 'F',
    name: undefined,
  })

  // ---- 路径穿越必须被拒（审计评论 #13；修复前 escapesWhitelist=true）----
  check('编码斜杠 + ..', parseDeepLink(`${S}open/settings/%2F..%2F..%2Fplugins%2Fp%2Fx`), null)
  check('编码点段', parseDeepLink(`${S}open/settings/%2e%2e%2f%2e%2e%2fplugins`), null)
  check('混合 ..%2F', parseDeepLink(`${S}open/settings/..%2Fplugins`), null)
  check('反斜杠', parseDeepLink(`${S}open/settings/%2e%2e%5Cplugins`), null)
  check('裸 ..', parseDeepLink(`${S}open/../plugins`), null)

  // ---- 非法百分号编码返回 null 而非抛错（审计评论 #12）----
  check('%FF 不抛错', parseDeepLink(`${S}open/settings/%FF`), null)
  check('launch 里的 %FF', parseDeepLink(`${S}launch/%FF`), null)

  // ---- 非本应用链接 / 未知动作 ----
  check('别的协议', parseDeepLink('https://example.com/open/settings'), null)
  check('内部 IPC 协议不当作深链', parseDeepLink('qomicex://localhost/api/health'), null)
  check('未知动作', parseDeepLink(`${S}nope/x`), null)
  check('install 未知子动作', parseDeepLink(`${S}install/wat?slug=a`), null)
  check('modpack 缺 fileId', parseDeepLink(`${S}install/modpack?type=mr&projectId=P`), null)
  check('modpack 未知 type', parseDeepLink(`${S}install/modpack?type=evil&projectId=P&fileId=F`), null)

  // ---- 官方域白名单是精确匹配（非后缀）----
  check('官方域', isTrustedInstallUrl('https://api.qomicex.top/a.qplugin'), true)
  check('官方域裸域', isTrustedInstallUrl('https://qomicex.top/a.qplugin'), true)
  check('后缀相同的钓鱼域', isTrustedInstallUrl('https://evil-qomicex.top/a.qplugin'), false)
  check('http 官方域不免确认', isTrustedInstallUrl('http://api.qomicex.top/a.qplugin'), false)

  // ---- 路由白名单边界 ----
  check('白名单外', isAllowedRoute('/plugins/p/x'), false)
  check('前缀相似但不同段', isAllowedRoute('/settings-evil'), false)
  check('子路径允许', isAllowedRoute('/settings/x'), true)

  // ---- launch target 反序解析（Windows 盘符不能被切坏）----
  check('无冒号 → 纯名字', splitLaunchTarget('MyPack'), { raw: 'MyPack', name: 'MyPack' })
  check('Windows 盘符 + 名字', splitLaunchTarget('C:\\mc\\inst:MyPack'), {
    raw: 'C:\\mc\\inst:MyPack',
    name: 'MyPack',
    dir: 'C:\\mc\\inst',
  })
  check('只有盘符、无实例名分隔', splitLaunchTarget('C:\\mc\\inst'), {
    raw: 'C:\\mc\\inst',
    name: 'C:\\mc\\inst',
  })
  check('名字本身含冒号（右侧切）', splitLaunchTarget('D:/g:we:ird'), {
    raw: 'D:/g:we:ird',
    name: 'ird',
    dir: 'D:/g:we',
  })
  check('只有半边 → 退化为纯名字', splitLaunchTarget(':MyPack'), { raw: ':MyPack', name: ':MyPack' })
  check('只有半边 → 退化为纯名字（尾）', splitLaunchTarget('C:\\mc\\:'), {
    raw: 'C:\\mc\\:',
    name: 'C:\\mc\\:',
  })
  check('盘符 + 名字（合法，不得被兜底误伤）', splitLaunchTarget('C:MyPack'), {
    raw: 'C:MyPack',
    name: 'MyPack',
    dir: 'C',
  })

  // ---- 同名实例歧义：绝不静默取第一个（本项修复的核心）----
  const sameName = [
    { id: 'idAAA', name: 'Same', gameDir: 'C:\\a' },
    { id: 'idBBB', name: 'Same', gameDir: 'C:\\b' },
    { id: 'idCCC', name: 'Same', gameDir: 'C:\\c' },
  ]
  check('单靠名字命中多个 → ambiguous（旧实现返回 idAAA）', matchLaunchTarget(sameName, splitLaunchTarget('Same')), {
    kind: 'ambiguous',
    candidates: sameName,
  })
  check('目录:名字 → 精确定位', matchLaunchTarget(sameName, splitLaunchTarget('C:\\b:Same')), {
    kind: 'matched',
    instance: sameName[1],
  })
  check('反斜杠/正斜杠等价', matchLaunchTarget(sameName, splitLaunchTarget('C:/b:Same')), {
    kind: 'matched',
    instance: sameName[1],
  })
  check('目录命中但实例名写错 → notFound（不得回退到同名的别人）', matchLaunchTarget(sameName, splitLaunchTarget('C:\\b:Other')), {
    kind: 'notFound',
  })
  check('只有唯一同名 → 正常命中', matchLaunchTarget([sameName[0]], splitLaunchTarget('Same')), {
    kind: 'matched',
    instance: sameName[0],
  })
  check(
    'ID 优先于名字（A 的 id 恰好是 B 的名字）',
    matchLaunchTarget(
      [
        { id: 'id-X', name: 'Same', gameDir: 'C:\\a' },
        { id: 'Same', name: 'Other', gameDir: 'C:\\b' },
      ],
      splitLaunchTarget('Same'),
    ),
    { kind: 'matched', instance: { id: 'Same', name: 'Other', gameDir: 'C:\\b' } },
  )
  check(
    '大小写不敏感仅在唯一命中时接受（Windows）',
    matchLaunchTarget([{ id: 'i', name: 'Same', gameDir: 'C:\\A' }], splitLaunchTarget('c:\\a:Same')),
    { kind: 'matched', instance: { id: 'i', name: 'Same', gameDir: 'C:\\A' } },
  )
  check(
    '大小写不同且有两个候选 → ambiguous（Linux 语义，不瞎猜）',
    matchLaunchTarget(
      [
        { id: 'i1', name: 'Same', gameDir: 'C:\\A' },
        { id: 'i2', name: 'Same', gameDir: 'C:\\a' },
      ],
      splitLaunchTarget('c:\\a:Same'),
    ),
    {
      kind: 'ambiguous',
      candidates: [
        { id: 'i1', name: 'Same', gameDir: 'C:\\A' },
        { id: 'i2', name: 'Same', gameDir: 'C:\\a' },
      ],
    },
  )
  check('列表为空 → notFound', matchLaunchTarget([], splitLaunchTarget('Same')), { kind: 'notFound' })

  console.log(`✅ deepLink: ${checks} 条断言全部通过`)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
