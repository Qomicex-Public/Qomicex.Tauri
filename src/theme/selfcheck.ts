/**
 * 自检：.qtheme 解析器 + 校验器的可运行验证。
 * 运行（Node 24+ 支持 type stripping）：
 *   node --experimental-strip-types src/theme/selfcheck.ts
 * 全部通过打印 ok，否则非零退出。
 */
import { readFileSync } from 'node:fs'
import { validateTheme, themeToCssVars, themeToCssBlock, ThemeError } from './schema.ts'

const mocha = JSON.parse(readFileSync(new URL('./themes/catppuccin-mocha.json', import.meta.url), 'utf8'))

let failed = 0
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    failed++
    console.error('FAIL:', msg)
  }
}

// 1) 合法主题 → 归一化 + 转 CSS vars
const t = validateTheme(mocha)
assert(t.id === 'catppuccin-mocha', 'id 解析')
assert(t.scheme === 'dark', 'scheme 解析')
assert(t.colors['background'] === '240 23% 9%', '颜色值解析')
const vars = themeToCssVars(t)
assert(vars['--background'] === '240 23% 9%', 'CSS var 名（-- 前缀）')
const block = themeToCssBlock(t, ':root[data-theme="x"]')
assert(block.includes('--background: 240 23% 9%;'), 'CSS 块含变量')
assert(block.startsWith(':root[data-theme="x"] {'), 'CSS 块选择器')

// 2) 点分命名归一化
const dotted = validateTheme({
  schemaVersion: 1,
  id: 'dotted',
  name: 'dotted',
  colors: { 'background.emphasis': '0 0% 10%' },
})
assert(dotted.colors['background-emphasis'] === '0 0% 10%', '点分 → 连字符')

// 3) 非法主题被拒绝 + 友好错误
function expectError(raw: unknown, probe: string): void {
  try {
    validateTheme(raw)
    failed++
    console.error('FAIL: 应抛错', probe)
  } catch (e) {
    assert(e instanceof ThemeError, `错误类型(${probe})`)
    assert(typeof (e as Error).message === 'string' && (e as Error).message.length > 0, `错误信息(${probe})`)
  }
}
expectError({ schemaVersion: 2, id: 'x', name: 'x', colors: {} }, 'schemaVersion=2')
expectError({ schemaVersion: 1, id: 'X', name: 'x', colors: { background: '0 0% 0%' } }, '非法 id')
expectError({ schemaVersion: 1, id: 'x', name: '', colors: { background: '0 0% 0%' } }, '空 name')
expectError({ schemaVersion: 1, id: 'x', name: 'x', colors: {} }, '空 colors')
expectError({ schemaVersion: 1, id: 'x', name: 'x', colors: { background: '' } }, '空值')
expectError('not json', '非 JSON 字符串') // validateTheme 不 parse 字符串 → 顶层非对象

if (failed > 0) {
  console.error(`${failed} 项失败`)
  process.exit(1)
}
console.log('ok')
