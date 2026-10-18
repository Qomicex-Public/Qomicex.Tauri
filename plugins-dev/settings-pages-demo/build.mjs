// 把 src/*.html 复制到 dist/：manifest 里的路径按仓库约定写 dist/（与 hello-plugin 一致），
// 而 dist/ 是 .gitignore 的，所以需要构建步骤。本插件是纯静态 HTML，没有打包需求。
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const root = import.meta.dirname
rmSync(join(root, 'dist'), { recursive: true, force: true })
mkdirSync(join(root, 'dist'), { recursive: true })
cpSync(join(root, 'src'), join(root, 'dist'), { recursive: true })
console.log('[settings-pages-demo] dist/ 已生成')
