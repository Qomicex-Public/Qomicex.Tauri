# 构建 L3 WASM 插件（Windows）：cargo build → 重命名产物为 plugin.wasm。
$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $ROOT

Write-Host "==> 编译 wasm（wasm32-unknown-unknown）"
rustup target add wasm32-unknown-unknown 2>$null | Out-Null
cargo build --release --target wasm32-unknown-unknown
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> 拷贝 plugin.wasm 到包根目录"
Copy-Item "$ROOT\target\wasm32-unknown-unknown\release\*.wasm" "$ROOT\plugin.wasm" -Force

Write-Host "==> 完成: $ROOT\plugin.wasm"