# __QOMICEX_PLUGIN_NAME__

由 `qomicex create __QOMICEX_PLUGIN_ID__` 生成的最小插件模板（Vite + React 19 + TypeScript + Tailwind + `@qomicex/plugin-ui`）。

## 开发

```bash
pnpm install
pnpm run dev      # Vite 热重载
```

## 打包与校验

```bash
qomicex verify    # manifest 合法性 + 权限最小化 + 长循环告警
qomicex pack      # tsc && vite build → 打 .qplugin
qomicex publish   # 设备流登录后签名并上传到商店
```

详见 `packages/qomicex-cli/README.md`。
