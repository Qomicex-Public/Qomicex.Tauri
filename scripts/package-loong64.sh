#!/usr/bin/env bash
# Copyright (C) 2026 Qomicex Launcher Contributors
# SPDX-License-Identifier: GPL-3.0-or-later
#
# 为 loongarch64 手工打 deb / rpm 包。
#
# 背景：tauri-bundler 的 Settings::binary_arch 用硬编码的 target triple 前缀
# 匹配架构，白名单只有 x86_64/i*/arm*/aarch64/riscv64/universal，其余一律
# panic!("Unexpected target triple {}")。LoongArch 没有对应分支，也没有
# Arch 枚举变体（见 tauri-v2.11.4 crates/tauri-bundler/src/bundle/settings.rs）。
# 因此 tauri build 的打包阶段在该架构上必然失败。
#
# 但同一命令的编译阶段是好的：`tauri build --no-bundle`（或等价的 cargo build）
# 能产出可用的 LoongArch ELF。本脚本就接在编译之后，按 Tauri 官方的 deb/rpm
# 布局自行组包，Architecture 字段用 Debian/龙芯约定的 loong64 / loongarch64。
#
# 用法：
#   VERSION=1.1.2-alpha20261103.0 bash scripts/package-loong64.sh
#
# 输入（由调用方保证已就绪）：
#   $BIN        编译出的可执行文件（默认 src-tauri/target/<triple>/release/Qomicex Launcher）
#   src-tauri/icons/*.png 图标
# 输出：
#   $OUT_DIR/qomicex-launcher_<version>_loong64.deb
#   $OUT_DIR/qomicex-launcher-<version>-1.loongarch64.rpm

set -euo pipefail

TRIPLE="loongarch64-unknown-linux-gnu"
ARCH_DEB="loong64"
ARCH_RPM="loongarch64"

APP_NAME="qomicex-launcher"
PKG_NAME="qomicex-launcher"
PRODUCT_NAME="Qomicex Launcher"
VERSION="${VERSION:?VERSION 环境变量必须提供}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${BIN:-$REPO_ROOT/src-tauri/target/$TRIPLE/release/Qomicex Launcher}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist-loong64}"
ICON_DIR="$REPO_ROOT/src-tauri/icons"
MAINTAINER="${MAINTAINER:-Qomicex Launcher Contributors}"
DESCRIPTION="${DESCRIPTION:-Minecraft Launcher}"
HOMEPAGE="${HOMEPAGE:-https://qomicex.top}"
DEPENDS_DEB="${DEPENDS_DEB:-libwebkit2gtk-4.1-0, libgtk-3-0, libayatana-appindicator3-1}"

log() { printf '>>> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$BIN" ] || die "找不到可执行文件: $BIN"
# 交叉编译静默出错时产物可能是宿主架构，先断言。
command -v readelf >/dev/null || die "缺少 readelf（binutils）"
readelf -h "$BIN" | grep -q 'Machine:.*LoongArch' \
  || die "产物不是 LoongArch: $(readelf -h "$BIN" | grep Machine)"

mkdir -p "$OUT_DIR"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# --- 组装文件树 ---------------------------------------------------------------
log "组装 $PRODUCT_NAME 文件树"
APPDIR="$STAGE/appdir"
mkdir -p "$APPDIR/usr/bin" \
         "$APPDIR/usr/share/applications" \
         "$APPDIR/usr/share/icons/hicolor/32x32/apps" \
         "$APPDIR/usr/share/icons/hicolor/128x128/apps" \
         "$APPDIR/usr/share/icons/hicolor/256x256@2/apps"

install -m 0755 "$BIN" "$APPDIR/usr/bin/$APP_NAME"
for size in 32x32 128x128 128x128@2x; do
  case "$size" in
    32x32)       dst="$APPDIR/usr/share/icons/hicolor/32x32/apps" ;;
    128x128)     dst="$APPDIR/usr/share/icons/hicolor/128x128/apps" ;;
    128x128@2x)  dst="$APPDIR/usr/share/icons/hicolor/256x256@2/apps" ;;
  esac
  src="$ICON_DIR/$size.png"
  [ -f "$src" ] || die "缺少图标: $src"
  install -m 0644 "$src" "$dst/$APP_NAME.png"
done

cat > "$APPDIR/usr/share/applications/$APP_NAME.desktop" <<EOF
[Desktop Entry]
Categories=Game;
Comment=$DESCRIPTION
Exec=$APP_NAME
StartupWMClass=$APP_NAME
Icon=$APP_NAME
Name=$PRODUCT_NAME
Terminal=false
Type=Application
EOF
chmod 0644 "$APPDIR/usr/share/applications/$APP_NAME.desktop"

# --- deb ----------------------------------------------------------------------
# 布局：debian-binary / control.tar.gz / data.tar.gz，三者用 ar 顺序打包。
log "构建 deb"
DEB_ROOT="$STAGE/deb"
mkdir -p "$DEB_ROOT/DEBIAN"
cp -a "$APPDIR/." "$DEB_ROOT/"

INSTALLED_SIZE=$(du -sk "$APPDIR" | cut -f1)
cat > "$DEB_ROOT/DEBIAN/control" <<EOF
Package: $PKG_NAME
Version: ${VERSION#v}
Architecture: $ARCH_DEB
Installed-Size: $INSTALLED_SIZE
Maintainer: $MAINTAINER
Homepage: $HOMEPAGE
Priority: optional
Depends: $DEPENDS_DEB
Description: $DESCRIPTION
EOF

# md5sums 覆盖 data 下的所有普通文件，路径相对包根（不带前导 /）。
(cd "$DEB_ROOT" && find usr -type f -print0 | sort -z | xargs -0 md5sum) \
  > "$DEB_ROOT/DEBIAN/md5sums"
chmod 0644 "$DEB_ROOT/DEBIAN/control" "$DEB_ROOT/DEBIAN/md5sums"

# postinst/prerm 无需额外动作：图标与 desktop 文件由 hicolor 主题自动识别。
printf '2.0\n' > "$STAGE/debian-binary"

DEB_OUT="$OUT_DIR/${PKG_NAME}_${VERSION#v}_${ARCH_DEB}.deb"
(cd "$DEB_ROOT" && tar -czf "$STAGE/control.tar.gz" --owner=0 --group=0 ./DEBIAN)
(cd "$DEB_ROOT" && tar -czf "$STAGE/data.tar.gz" --owner=0 --group=0 ./usr)
rm -f "$DEB_OUT"
(cd "$STAGE" && ar rc "$DEB_OUT" debian-binary control.tar.gz data.tar.gz)
log "  -> $DEB_OUT"

# --- rpm ----------------------------------------------------------------------
# rpm 在 Debian 宿主上可用，靠 rpmbuild 的用户宏指定 target 架构。
log "构建 rpm"
if command -v rpmbuild >/dev/null; then
  TOPDIR="$STAGE/rpmbuild"
  mkdir -p "$TOPDIR"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
  tar -czf "$TOPDIR/SOURCES/$PKG_NAME-$VERSION.tar.gz" -C "$STAGE" appdir

  cat > "$TOPDIR/SPECS/$PKG_NAME.spec" <<EOF
Name:           $PKG_NAME
Version:        ${VERSION#v}
Release:        1
Summary:        $DESCRIPTION
License:        GPL-3.0-or-later
URL:            $HOMEPAGE
BuildArch:      $ARCH_RPM
AutoReqProv:    no
Requires:       webkit2gtk4.1

%description
$DESCRIPTION

%prep
%setup -q -c -n $PKG_NAME-$VERSION

%build

%install
mkdir -p %{buildroot}
cp -a appdir/. %{buildroot}/

%files
/usr/bin/$APP_NAME
/usr/share/applications/$APP_NAME.desktop
/usr/share/icons/hicolor/32x32/apps/$APP_NAME.png
/usr/share/icons/hicolor/128x128/apps/$APP_NAME.png
/usr/share/icons/hicolor/256x256@2/apps/$APP_NAME.png

%changelog
EOF

  rpmbuild --define "_topdir $TOPDIR" \
           --define "_binary_payload w2.xzdio" \
           --target "$ARCH_RPM" \
           -bb "$TOPDIR/SPECS/$PKG_NAME.spec" >/dev/null 2>&1 \
    || die "rpmbuild 失败（去掉 >/dev/null 可看完整输出）"

  found=$(find "$TOPDIR/RPMS" -name '*.rpm' | head -1)
  [ -n "$found" ] || die "rpmbuild 未产出 rpm"
  RPM_OUT="$OUT_DIR/${PKG_NAME}-${VERSION#v}-1.${ARCH_RPM}.rpm"
  cp "$found" "$RPM_OUT"
  log "  -> $RPM_OUT"
else
  log "  跳过 rpm：未安装 rpmbuild"
fi

log "完成"
ls -lh "$OUT_DIR"
