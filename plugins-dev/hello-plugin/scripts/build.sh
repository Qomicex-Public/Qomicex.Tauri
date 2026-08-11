#!/usr/bin/env bash
# 打包插件为 .qplugin（zip，manifest.json 在根）。
# 用法: bash scripts/build.sh [版本]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-0.1.0}"
PLUGIN_ID="hello-plugin"
OUT_DIR="$ROOT/release"

echo "==> 安装依赖"
pnpm install --frozen-lockfile 2>/dev/null || npm install

echo "==> 构建前端 (tsc + vite)"
pnpm build 2>/dev/null || npm run build

echo "==> 整理 dist"
# dist/index.html 已由 vite 生成；overlay.html 与 theme.css 需要手动拷入
cp "$ROOT/overlay.html" "$ROOT/dist/overlay.html"
cp "$ROOT/theme.css" "$ROOT/dist/theme.css"

echo "==> 组装 .qplugin"
STAGING="$ROOT/.staging-$PLUGIN_ID"
rm -rf "$STAGING" "$OUT_DIR"
mkdir -p "$STAGING/dist" "$OUT_DIR"
cp "$ROOT/dist/index.html" "$STAGING/dist/"
cp -r "$ROOT/dist/assets" "$STAGING/dist/assets"
cp "$ROOT/dist/overlay.html" "$STAGING/dist/"
cp "$ROOT/dist/theme.css" "$STAGING/dist/"
cp "$ROOT/manifest.json" "$STAGING/"

# 替换 manifest 中的版本号
if command -v jq >/dev/null 2>&1; then
  jq --arg v "$VERSION" '.version = $v' "$STAGING/manifest.json" > "$STAGING/manifest.tmp" && mv "$STAGING/manifest.tmp" "$STAGING/manifest.json"
fi

OUT="$OUT_DIR/${PLUGIN_ID}-${VERSION}.qplugin"
cd "$STAGING"
if command -v zip >/dev/null 2>&1; then
  zip -qr "$OUT" .
else
  # Windows 无 zip 时用 PowerShell
  powershell -NoProfile -Command "Compress-Archive -Path '*' -DestinationPath '$OUT' -Force"
fi
cd "$ROOT"
rm -rf "$STAGING"

echo "==> 完成: $OUT"
