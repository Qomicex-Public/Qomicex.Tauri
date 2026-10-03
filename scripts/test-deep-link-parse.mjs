/**
 * 深链解析的回归测试（issue #127 审计评论 #12 / #13）。
 *
 * 用手写断言而不是引入测试框架：本仓库前端无测试框架（见 AGENTS.md「前端无测试框架」），
 * 而这两条是**安全边界**，退化会在无人察觉时放开白名单，必须钉住。
 * 跑法：`node scripts/test-deep-link-parse.mjs`
 */
import { parseDeepLink, isAllowedRoute, isTrustedInstallUrl, DEEP_LINK_SCHEME } from '../src/lib/deepLink.ts'

let passed = 0
let failed = 0

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}\n       expected: ${JSON.stringify(expected)}\n       actual:   ${JSON.stringify(actual)}`)
  }
}

const S = `${DEEP_LINK_SCHEME}://`

console.log('[1] 正常解析（防修复误伤）')
check('open 根路径', parseDeepLink(`${S}open/`), { kind: 'open', route: '/' })
check('open 白名单页', parseDeepLink(`${S}open/settings`), { kind: 'open', route: '/settings' })
check('open 子路径', parseDeepLink(`${S}open/instances/abc`), { kind: 'open', route: '/instances/abc' })
check('launch', parseDeepLink(`${S}launch/1.20.1-Forge`), { kind: 'launch', target: '1.20.1-Forge' })
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

console.log('[2] 路径穿越必须被拒（评论 #13；修复前 escapesWhitelist=true）')
check('编码斜杠 + ..', parseDeepLink(`${S}open/settings/%2F..%2F..%2Fplugins%2Fp%2Fx`), null)
check('编码点段', parseDeepLink(`${S}open/settings/%2e%2e%2f%2e%2e%2fplugins`), null)
check('混合 ..%2F', parseDeepLink(`${S}open/settings/..%2Fplugins`), null)
check('反斜杠', parseDeepLink(`${S}open/settings/%2e%2e%5Cplugins`), null)
check('裸 ..', parseDeepLink(`${S}open/../plugins`), null)

console.log('[3] 非法百分号编码返回 null 而非抛错（评论 #12）')
check('%FF 不抛错', parseDeepLink(`${S}open/settings/%FF`), null)
check('launch 里的 %FF', parseDeepLink(`${S}launch/%FF`), null)

console.log('[4] 非本应用链接 / 未知动作')
check('别的协议', parseDeepLink('https://example.com/open/settings'), null)
check('内部 IPC 协议不当作深链', parseDeepLink('qomicex://localhost/api/health'), null)
check('未知动作', parseDeepLink(`${S}nope/x`), null)
check('install 未知子动作', parseDeepLink(`${S}install/wat?slug=a`), null)
check('modpack 缺 fileId', parseDeepLink(`${S}install/modpack?type=mr&projectId=P`), null)
check('modpack 未知 type', parseDeepLink(`${S}install/modpack?type=evil&projectId=P&fileId=F`), null)

console.log('[5] 官方域白名单是精确匹配（非后缀）')
check('官方域', isTrustedInstallUrl('https://api.qomicex.top/a.qplugin'), true)
check('官方域裸域', isTrustedInstallUrl('https://qomicex.top/a.qplugin'), true)
check('后缀相同的钓鱼域', isTrustedInstallUrl('https://evil-qomicex.top/a.qplugin'), false)
check('http 官方域不免确认', isTrustedInstallUrl('http://api.qomicex.top/a.qplugin'), false)

console.log('[6] 路由白名单边界')
check('白名单外', isAllowedRoute('/plugins/p/x'), false)
check('前缀相似但不同段', isAllowedRoute('/settings-evil'), false)
check('子路径允许', isAllowedRoute('/settings/x'), true)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
