#!/usr/bin/env bash
# 移除 Tauri 打包进 AppImage 的 libwayland-* 并重新打包。
#
# 捆绑的 libwayland-* 会遮蔽宿主 Mesa 依赖链，在较新的 Wayland/Mesa 主机上
# 报 "Could not create default EGL display: EGL_BAD_PARAMETER" 后中止
# （Tauri#15665、Tauri#15976、Qomicex.Tauri#202）。WebKitGTK 本身硬依赖
# libwayland-client，宿主必装，移除后动态链接回落到宿主库。Tauri 正式提供
# bundle.linux.appimage.excludeLibraries 后可整体移除本脚本及其 CI 调用。
set -euo pipefail

# appimagetool 版本与资产 SHA256 钉死（AppImage/appimagetool releases 1.9.1）
APPIMAGETOOL_VERSION=1.9.1
APPIMAGETOOL_SHA256_x86_64=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
APPIMAGETOOL_SHA256_aarch64=f0837e7448a0c1e4e650a93bb3e85802546e60654ef287576f46c71c126a9158

usage() {
  echo "usage: $0 <appimage-file> <x86_64|aarch64>" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage
APPIMAGE=$1
ARCH=$2

case "$ARCH" in
x86_64 | aarch64) ;;
*) usage ;;
esac

[ -f "$APPIMAGE" ] || { echo "fix-appimage: no such file: $APPIMAGE" >&2; exit 1; }
APPIMAGE=$(readlink -f "$APPIMAGE")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# --appimage-extract 解包到 $PWD/squashfs-root，不依赖 FUSE
mkdir "$WORK/extract"
(cd "$WORK/extract" && "$APPIMAGE" --appimage-extract >/dev/null)

LIB_ROOT="$WORK/extract/squashfs-root/usr/lib"
# -print -quit 只取首个匹配，避免 find|grep -q 在 pipefail 下的 SIGPIPE 竞态
if [ -z "$(find "$LIB_ROOT" -name 'libwayland-*.so*' -print -quit)" ]; then
  echo "fix-appimage: no bundled libwayland-* under usr/lib; leaving $APPIMAGE unchanged"
  exit 0
fi
find "$LIB_ROOT" -name 'libwayland-*.so*' -print -delete

case "$ARCH" in
x86_64)
  TOOL_ASSET=appimagetool-x86_64.AppImage
  EXPECTED_SHA256=$APPIMAGETOOL_SHA256_x86_64
  ;;
aarch64)
  TOOL_ASSET=appimagetool-aarch64.AppImage
  EXPECTED_SHA256=$APPIMAGETOOL_SHA256_aarch64
  ;;
esac

CACHE_DIR=${RUNNER_TEMP:-$WORK}
TOOL="$CACHE_DIR/$TOOL_ASSET"
if [ ! -f "$TOOL" ]; then
  curl -fsSL --retry 3 -o "$TOOL" \
    "https://github.com/AppImage/appimagetool/releases/download/${APPIMAGETOOL_VERSION}/${TOOL_ASSET}"
fi
if ! echo "${EXPECTED_SHA256}  ${TOOL}" | sha256sum --check --status; then
  echo "fix-appimage: appimagetool SHA256 mismatch" >&2
  exit 1
fi

REPACKED="$WORK/repacked.AppImage"
ARCH=$ARCH "$TOOL" --appimage-extract-and-run "$WORK/extract/squashfs-root" "$REPACKED"
chmod 755 "$REPACKED"
mv -f "$REPACKED" "$APPIMAGE"

# createUpdaterArtifacts 在打包时产出的签名对应旧文件内容，重新签名或删除过期签名
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [ -f "$APPIMAGE.sig" ]; then
  if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -n "$REPO_ROOT" ]; then
    (cd "$REPO_ROOT" && npx tauri signer sign "$APPIMAGE")
  else
    echo "fix-appimage: TAURI_SIGNING_PRIVATE_KEY not available; removing stale $APPIMAGE.sig"
    rm -f "$APPIMAGE.sig"
  fi
fi
# Debug 工作流优先查找 .AppImage.tar.gz（Tauri v1 更新包格式，v2 不再产出内容一致的
# 包），重新打包后该派生产物已失效，删除以回落到原始 AppImage
rm -f "$APPIMAGE.tar.gz" "$APPIMAGE.tar.gz.sig"

# 内容断言：重打包结果不再含 libwayland-*，并打印 WebKitGTK 库版本供排查
mkdir "$WORK/verify"
(cd "$WORK/verify" && "$APPIMAGE" --appimage-extract >/dev/null)
if [ -n "$(find "$WORK/verify/squashfs-root/usr/lib" -name 'libwayland-*.so*' -print -quit)" ]; then
  echo "fix-appimage: libwayland-* still present after repack" >&2
  exit 1
fi
echo "fix-appimage: WebKitGTK libs in final AppImage:"
find "$WORK/verify/squashfs-root/usr/lib" \( -name 'libwebkit2gtk*' -o -name 'libjavascriptcoregtk*' \) -print
echo "fix-appimage: OK — $APPIMAGE repacked without bundled libwayland-*"
