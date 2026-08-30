// 库插件入口：注册本库提供的方法，供其他插件调用。
// 示例：提供 renderMarkdown 方法（这里用简单实现，可替换为真实库逻辑）。

// 插件激活时注册方法；独立浏览器直开（无桥）时静默跳过。
// 直接经 window.__PLUGIN_API__ 调用，便于 qomicex verify 静态识别权限。
window.__PLUGIN_API__?.registerMethod('renderMarkdown', (md) => {
  // 简单占位实现：把换行转 <br>。真实库应引入 markdown 解析器。
  return String(md ?? '')
    .split(/\n{2,}/)
    .map((p) => `<p>${p}</p>`)
    .join('')
})