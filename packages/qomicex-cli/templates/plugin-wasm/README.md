# __QOMICEX_PLUGIN_NAME__

由 `qomicex create __QOMICEX_PLUGIN_ID__ --template wasm` 生成的 **L3 WASM 插件**模板（Rust + wasmtime 沙箱，无浏览器环境）。

## 结构

```
plugin-wasm/
├── manifest.json      # layers:["l3"] + permissions:["wasm:execute"]（无 entry）
├── Cargo.toml         # cdylib crate
├── src/lib.rs         # on_load / on_unload / get_manifest + 自定义导出
└── scripts/
    ├── build.sh       # Unix: cargo build → 拷贝 plugin.wasm
    └── build.ps1      # Windows 等价脚本
```

## 开发

```bash
rustup target add wasm32-unknown-unknown
# Unix
bash scripts/build.sh
# Windows
pwsh scripts/build.ps1
# 产物：plugin.wasm（包根目录，网关按固定文件名加载）
```

`src/lib.rs` 通过 `#[link(wasm_import_module = "qomicex")]` 导入宿主函数（`log` / `db_set` / `db_get` / `get_plugin_id`），导出 `on_load` / `on_unload` / `get_manifest` 与自定义函数。

## 打包与校验

```bash
qomicex verify    # manifest / 权限（L3 跳过 JS 权限扫描）
qomicex pack      # 检测到 Cargo.toml → cargo build → 打包 plugin.wasm
qomicex publish   # 设备流登录后签名并上传到商店
```

## 从前端调用

```js
await __PLUGIN_API__.callWasm('__QOMICEX_PLUGIN_ID__', 'db_set_test')   // 自定义导出
await __PLUGIN_API__.callWasm('__QOMICEX_PLUGIN_ID__', 'on_load')
```

详见 `docs/plugins/wasm-plugin.md` 与 `packages/qomicex-cli/README.md`。