import { build } from 'esbuild'
import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { resolve } from 'path'

const dist = resolve(import.meta.dirname, '..', 'dist')

const jsResult = await build({
  entryPoints: [resolve(import.meta.dirname, '..', 'src/overlay.tsx')],
  bundle: true,
  format: 'iife',
  write: false,
  minify: true,
  jsx: 'automatic',
  jsxImportSource: 'react',
  platform: 'browser',
  target: 'es2020',
  loader: { '.tsx': 'tsx', '.ts': 'ts', '.js': 'js' },
})

const js = jsResult.outputFiles[0].text

const cssFiles = readdirSync(resolve(dist, 'assets')).filter(f => f.endsWith('.css'))
const css = cssFiles.map(f => readFileSync(resolve(dist, 'assets', f), 'utf-8')).join('\n')

const html = `<!DOCTYPE html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI 助手</title>
  <style>
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
    #root { height: 100%; }
  </style>
  <style>${css}</style>
</head>
<body>
  <div id="root"></div>
  <script>${js}</script>
</body>
</html>`

writeFileSync(resolve(dist, 'overlay.html'), html)
console.log(`Generated self-contained overlay.html (${(html.length / 1024).toFixed(0)}KB)`)
