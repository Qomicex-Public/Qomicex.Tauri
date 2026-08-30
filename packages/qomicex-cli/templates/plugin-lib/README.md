# __QOMICEX_PLUGIN_NAME__

由 `qomicex create __QOMICEX_PLUGIN_ID__ --template lib` 生成的**纯库插件**模板（参照 MarkdownLibrary：无 UI，只注册方法供其他插件 `callPlugin` 调用）。

## 开发

```bash
pnpm install
# 在 src/main.js 中注册库方法（api.registerMethod）
pnpm run build     # esbuild 打包 src/ → dist/
```

## 供其他插件调用

```js
// 依赖方
const html = await __PLUGIN_API__.callPlugin('__QOMICEX_PLUGIN_ID__', 'renderMarkdown', '**bold**')
```

其他插件需在 manifest `dependencies` 声明本库：

```json
{ "id": "__QOMICEX_PLUGIN_ID__", "version": ">=0.1.0" }
```

## 打包与校验

```bash
qomicex verify    # manifest 合法性 + 权限最小化 + 长循环告警
qomicex pack      # 构建并打 .qplugin
qomicex publish   # 设备流登录后签名并上传到商店
```

详见 `packages/qomicex-cli/README.md`。