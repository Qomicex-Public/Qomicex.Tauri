#!/usr/bin/env bash
# 构建 L3 WASM 插件：cargo build → 重命名产物为 plugin.wasm 放入包根目录。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> 编译 wasm（wasm32-unknown-unknown）"
rustup target add wasm32-unknown-unknown 2>/dev/null || true
cargo build --release --target wasm32-unknown-unknown

echo "==> 拷贝 plugin.wasm 到包根目录"
cp "$ROOT/target/wasm32-unknown-unknown/release/"*.wasm "$ROOT/plugin.wasm"

echo "==> 完成: $ROOT/plugin.wasm"