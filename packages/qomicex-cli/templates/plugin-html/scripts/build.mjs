// 纯 HTML/CSS/JS 插件：esbuild 打包 src/ → dist/。
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// JS 打包：src/main.js → dist/main.js（bundle + minify）
await build({
  entryPoints: [join(src, 'main.js')],
  outfile: join(dist, 'main.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
})

// HTML / CSS 拷贝（index.html 引用 ./main.js）
cpSync(join(src, 'index.html'), join(dist, 'index.html'))
if (existsSync(join(src, 'style.css'))) cpSync(join(src, 'style.css'), join(dist, 'style.css'))

// 根目录 theme.css → dist/theme.css（manifest entry.theme 指向）
if (existsSync(join(root, 'theme.css'))) cpSync(join(root, 'theme.css'), join(dist, 'theme.css'))

console.log('✔ 构建完成 → dist/')