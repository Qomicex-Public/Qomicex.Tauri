// 纯 HTML 插件的入口脚本：与 window.__PLUGIN_API__ 交互。
// 独立浏览器直开（无启动器）时 __PLUGIN_API__ 为 undefined，需判空降级。
function getApi() {
  return window.__PLUGIN_API__ ?? null
}

document.getElementById('btn')?.addEventListener('click', async () => {
  const api = getApi()
  if (!api) {
    document.getElementById('btn').textContent = '未连接启动器（浏览器直开）'
    return
  }
  const settings = await api.call('getSettings')
  await api.call('showToast', '设置项数量: ' + Object.keys(settings).length, 'success')
})