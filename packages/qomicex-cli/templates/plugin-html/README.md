# __QOMICEX_PLUGIN_NAME__

由 `qomicex create __QOMICEX_PLUGIN_ID__ --template html` 生成的纯 HTML/CSS/JS 插件模板（esbuild 打包，无 React/Vite 依赖）。

## 开发

```bash
pnpm install
# 编辑 src/ 下的 index.html / style.css / main.js
pnpm run build     # esbuild 打包 src/ → dist/
```

## 打包与校验

```bash
qomicex verify    # manifest 合法性 + 权限最小化 + 长循环告警
qomicex pack      # 构建并打 .qplugin
qomicex publish   # 设备流登录后签名并上传到商店
```

详见 `packages/qomicex-cli/README.md`。