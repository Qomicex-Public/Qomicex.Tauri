// 库插件（lib）：无 UI，只注册方法供其他插件 callPlugin 调用。
// esbuild 打包 src/main.js（含 registerMethod）→ dist/main.js，拷贝 src/index.html。
import { build } from 'esbuild'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'src')
const dist = join(root, 'dist')

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

// 库逻辑打包：src/main.js → dist/main.js（bundle + minify）
await build({
  entryPoints: [join(src, 'main.js')],
  outfile: join(dist, 'main.js'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
})

// 入口 HTML 拷贝（激活所需；页面内容可仅提示库已加载）
cpSync(join(src, 'index.html'), join(dist, 'index.html'))

console.log('✔ 构建完成 → dist/')