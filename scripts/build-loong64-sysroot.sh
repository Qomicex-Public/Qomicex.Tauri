#!/usr/bin/env bash
# 在 x86_64 宿主上构建 LoongArch64 sysroot，供 loongarch64 交叉编译使用。
#
# 背景：release.yml 的 loongarch64 作业原先跑在 QEMU 用户态模拟的 loong64 容器里，
# 整个 Rust + Tauri 构建都在模拟下执行，耗时是原生的数量级，且 pnpm tarball 完整性
# 校验在 QEMU 下异常（工作流曾被迫把 --frozen-lockfile 降级为 --no-frozen-lockfile）。
# 改为在 x86_64 runner 上直接交叉编译后，构建阶段不再有任何架构模拟。
#
# 工具链取 loong64 官方 loong64/cross-tools releases，自带完整 glibc sysroot；
# 本脚本把 loong64 Debian 的原生库 deb 解进**同一个** sysroot，使 gcc 与 glibc
# 版本一致（工具链 glibc 必须 ≥ 系统库所依赖的 glibc，否则链接期符号缺失）。
#
# 用法：
#   TOOLS_DIR=/opt/x-tools bash scripts/build-loong64-sysroot.sh
# 产物：$SYSROOT（默认 $RUNNER_TEMP/loong64-sysroot，未设置 RUNNER_TEMP 时用 ./loong64-sysroot）
#
# 关键设计：deb 的 .pc 文件归属不能靠猜包名。实测 glib-2.0.pc 属于 libgio-2.0-dev 而非
# libglib2.0-dev，靠「看 Depends 递归」会静默漏包。故此处用官方 Contents-loong64.gz
# 建立 文件→包 的确定性映射，缺 .pc 时反查并补包。

set -euo pipefail

MIRROR="${LOONG64_MIRROR:-https://mirrors.loong64.com}"
SUITE="${LOONG64_SUITE:-trixie}"
TOOLS_DIR="${TOOLS_DIR:-/opt/x-tools}"
SYSROOT="${SYSROOT:-${RUNNER_TEMP:-.}/loong64-sysroot}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Rust/工具链三元组，与 Debian 的 multiarch 元组（DEB_ARCH）不是同一个名字。
TRIPLE="loongarch64-unknown-linux-gnu"
DEB_ARCH="loongarch64-linux-gnu"
PKGCONFIG_DIRS=(
  "$SYSROOT/usr/lib/loongarch64-linux-gnu/pkgconfig"
  "$SYSROOT/usr/share/pkgconfig"
  "$SYSROOT/usr/lib/pkgconfig"
)

# 与 release.yml 现有 apt 行、.github/docker/Dockerfile.loong64 保持一致。
SEED_PACKAGES=(
  libwebkit2gtk-4.1-dev
  libgtk-3-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  libssl-dev
  libglib2.0-dev
)

# 这些 .pc 是 tauri / wry / webkit2gtk-sys / gtk-sys / openssl-sys 等 -sys crate
# 在构建期用 pkg-config 查找的入口，缺任何一个都会在 cargo 阶段才报错，难定位。
REQUIRED_PC=(
  glib-2.0 gobject-2.0 gio-2.0
  gtk+-3.0 cairo pango pangocairo
  atk gdk-3.0 gdk-pixbuf-2.0
  webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0
  ayatana-appindicator3-0.1
  openssl
)

log() { printf '>>> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

fetch() { # fetch <url> <dest>
  # -C - 让 curl 断点续传：Contents 索引 48MB，弱网下实测会被对端重置而中断，
  # --retry 虽会重试但每次都从 0 开始，反复整包重下（本机调试时在此卡了很久）。
  # --speed-limit/--speed-time 再加一道：持续低速也主动断，交给 -C 续传。
  # --speed-time 单独给宽限：实测这条链路常长时间低于 10KB/s 但仍在推进，
  # 卡太紧会把「慢」误判成「挂」而反复重来。阈值取 1KB/s / 120s，
  # 只在真的停滞时才交给 -C 续传。
  curl -fSL --retry 5 --retry-delay 2 -C - \
    --speed-limit 1024 --speed-time 120 "$1" -o "$2" \
    || die "下载失败: $1"
}

# --- 索引 ---------------------------------------------------------------------
log "拉取 $SUITE 的 Packages 与 Contents 索引"
fetch "$MIRROR/debian/dists/$SUITE/main/binary-loong64/Packages.gz" "$WORK/Packages.gz"
fetch "$MIRROR/debian/dists/$SUITE/main/Contents-loong64.gz" "$WORK/Contents.gz"

# Contents 是全量文件清单（数十 MB），只在需要反查时建索引。
contents_lookup() { # contents_lookup <相对路径> → 打印提供该文件的包名
  local want="$1"
  # Contents 第二列形如 "    libdevel/libgtk-3-dev"（前导空格 + 可选 section 前缀，
  # 多属主时逗号分隔）。不 trim 会让 install_pkg 查不到包而静默跳过。
  [ -f "$WORK/contents.idx" ] || zcat "$WORK/Contents.gz" \
    | awk -F'\t' '$1 ~ /pkgconfig\/.*\.pc$/ { print $1 "\t" $2 }' > "$WORK/contents.idx"
  awk -F'\t' -v w="$want" '
    $1 == w {
      n = split($2, owners, ",")
      for (i = 1; i <= n; i++) {
        o = owners[i]
        sub(/^[ \t]+/, "", o); sub(/[ \t]+$/, "", o)
        sub(/^.*\//, "", o)
        if (o != "") { print o; exit }
      }
    }
  ' "$WORK/contents.idx"
}

# --- sysroot 准备 -------------------------------------------------------------
# glibc 的权威来源是工具链自带的 sysroot，系统库 deb 解进同一棵树。
# 路径不写死：交叉 tarball 解包后 sysroot 位于 $TRIPLE/$TRIPLE/sysroot（嵌套一层），
# 而 gcc 的 --print-sysroot 已内建正确解析，直接问它，避免随工具链版本改布局就失效。
CROSS_GCC="$TOOLS_DIR/$TRIPLE/bin/$TRIPLE-gcc"
[ -x "$CROSS_GCC" ] || die "未找到交叉 gcc: $CROSS_GCC（先解包 cross-tools 到 $TOOLS_DIR）"

TOOLCHAIN_SYSROOT="$("$CROSS_GCC" --print-sysroot)"
[ -d "$TOOLCHAIN_SYSROOT" ] || die "工具链 sysroot 不存在: $TOOLCHAIN_SYSROOT"

mkdir -p "$SYSROOT"
# 用 cp -a 而非就地解包：工具链 sysroot 属于 /opt/x-tools，污染后本作业后续步骤不可复用。
cp -a "$TOOLCHAIN_SYSROOT/." "$SYSROOT/"
log "sysroot 基底来自工具链自带的 glibc: $TOOLCHAIN_SYSROOT"

# 记录每个包已处理，避免重复下载；SKIPPED 收集索引中不存在的包。
declare -A INSTALLED=()
SKIPPED=()

install_pkg() { # install_pkg <包名>
  local pkg="$1"
  [ -n "${INSTALLED[$pkg]:-}" ] && return 0
  local fn
  fn=$(awk -v RS='' -v pkg="$pkg" '
    $0 ~ "(^|\n)Package: " pkg "\n" { for (i = 1; i <= NF; i++) if ($i == "Filename:") { print $(i+1); exit } }
  ' "$WORK/Packages.txt")
  # 闭包里允许出现索引中不存在的包：loong64 移植源的 Depends 常引用只在
  # 原生 Debian 存在的 -dev 包（如 gir1.2-*-dev 只提供 GIR 描述，不提供
  # 链接期需要的 .so/.pc）。这类包对交叉编译无用，跳过而非中断——
  # 是否真的需要，由末尾的 .pc 校验判定。
  if [ -z "$fn" ]; then
    SKIPPED+=("$pkg")
    INSTALLED[$pkg]=1
    return 0
  fi
  # 只抽取交叉链接真正用得到的路径：头文件、.pc、.so/.a。
  #
  # 不用 dpkg-deb -x 全量展开：它会把 debconf、dictionaries-common、locale、
  # gsettings schema 一并拉进来（-dev 包的 Depends 会链到这些桌面配置包），
  # 实测闭包 386 个包即 1.4G，CI runner 磁盘会被撑爆且毫无用处。
  # 这里用 tar 按路径白名单抽取，天然把闭包大小限制在链接所需的规模。
  log "  解包 $pkg"
  curl -fsSL --retry 5 "$MIRROR/debian/$fn" -o "$WORK/pkg.deb" \
    || die "下载 $pkg 失败"
  # 先从归档清单筛出实际存在的白名单成员，再按名字解包，而不是用通配符让 tar
  # 自行匹配。
  #
  # 原因：实测 GNU tar 对「请求的成员不存在」返回 2，与真正的 IO/格式失败同码，
  # 无法靠退出码区分（预检归档可读性也不能替代——那只拦得住下载截断，拦不住
  # 解包阶段的磁盘满/权限错误）。改成先列举再按名解包后：
  #  - 没有匹配成员 → 列表为空，正常跳过（很多纯数据包不含 lib/）
  #  - 有匹配成员 → 整条管道退出码必须为 0，否则是真失败，直接中断
  # 与 fetch() 同理：单个 deb 在弱网下也会被重置（实测 libsqlite3-dev 中断过），
  # 用 -C - 续传而非整包重来。
  curl -fL --retry 5 --retry-delay 2 -C - \
    --speed-limit 1024 --speed-time 120 "$MIRROR/debian/$fn" -o "$WORK/pkg.deb" \
    || die "下载 $pkg 失败"

  # 列举必须直接在当前 shell 里跑管道，不能写成$( ... ) 命令替换：命令替换会开
  # 子 shell，父 shell 的 PIPESTATUS 拿不到子shell 里的管道状态（实测 ps[1]
  # 直接 unbound，set -u 下会中止脚本）。故先落盘再筛。
  set +e
  dpkg-deb --fsys-tarfile "$WORK/pkg.deb" 2>/dev/null \
    | tar -tf /dev/stdin 2>/dev/null > "$WORK/list.txt"
  ps=("${PIPESTATUS[@]}")
  grep -E '^\./(usr/include|usr/lib|lib|usr/share/pkgconfig)/' \
    "$WORK/list.txt" > "$WORK/members.txt"
  set -e
  # 只对前两段硬性检查：grep 无匹配返回 1 属正常（很多纯数据包不含这些路径），
  # 但 dpkg-deb / tar 失败同样表现为 MEMBERS 为空，若不区分就会把「归档损坏 /
  # 下载截断」当成「无匹配成员」而跳过，并把它标记成已装。
  [ "${ps[0]}" -eq 0 ] && [ "${ps[1]}" -eq 0 ] \
    || die "读取归档失败 $pkg（dpkg-deb=${ps[0]} tar=${ps[1]}）"
  if [ -s "$WORK/members.txt" ]; then
    set +e
    dpkg-deb --fsys-tarfile "$WORK/pkg.deb" \
      | tar -x -C "$SYSROOT" --no-recursion -T "$WORK/members.txt"
    rc=${PIPESTATUS[1]}
    set -e
    [ "$rc" -eq 0 ] || die "解包 $pkg 失败（tar 退出码 $rc）"
  else
    log "    （$pkg 不含 include/lib/pkgconfig，跳过）"
  fi
  INSTALLED[$pkg]=1
}

# Depends 展开（含 Provides 兜底）。不做版本约束比较：本仓库只需要闭包存在，
# 而 loong64 源内的版本是自洽的。
expand_deps() { # expand_deps <已排队的包...>
  local queue=("$@")
  while [ ${#queue[@]} -gt 0 ]; do
    local cur="${queue[0]}"
    queue=("${queue[@]:1}")
    [ -n "${INSTALLED[$cur]:-}" ] && continue
    install_pkg "$cur"
    local deps
    deps=$(awk -v RS='' -v pkg="$cur" '
      $0 ~ "(^|\n)Package: " pkg "\n" {
        if (match($0, /\nDepends: [^\n]*/)) {
          s = substr($0, RSTART + 10, RLENGTH - 10)
          gsub(/\n[ ]+/, " ", s)
          n = split(s, a, ",")
          for (i = 1; i <= n; i++) {
            gsub(/^ +| +$/, "", a[i])
            sub(/ .*/, "", a[i])
            sub(/\(.*/, "", a[i])
            gsub(/^ +| +$/, "", a[i])
            if (a[i] != "") print a[i]
          }
        }
      }
    ' "$WORK/Packages.txt")
    local d
    for d in $deps; do
      case "$d" in
        libc6|libc-bin) continue ;;   # glibc 由工具链 sysroot 提供，不能被 deb 覆盖
      esac
      queue+=("$d")
    done
  done
}

log "展开依赖闭包（种子 ${#SEED_PACKAGES[@]} 个）"
zcat "$WORK/Packages.gz" > "$WORK/Packages.txt"
expand_deps "${SEED_PACKAGES[@]}"

# --- .pc 反查补包 --------------------------------------------------------------
# 上面的 Depends 闭包可能不含某个 .pc 的真正属主（.pc 常在 -dev-bin / -x-dev 等
# 旁支包里）。逐个校验，缺失则用 Contents 反查属主并重跑闭包。
for _round in 1 2 3; do
  missing=()
  export PKG_CONFIG_SYSROOT_DIR="$SYSROOT"
  export PKG_CONFIG_PATH=""
  export PKG_CONFIG_LIBDIR
  PKG_CONFIG_LIBDIR="$(IFS=:; echo "${PKGCONFIG_DIRS[*]}")"
  for pc in "${REQUIRED_PC[@]}"; do
    pkg-config --exists "$pc" 2>/dev/null || missing+=("$pc")
  done
  [ ${#missing[@]} -eq 0 ] && break
  [ "$_round" = "3" ] && die "以下 .pc 在三轮补包后仍缺失: ${missing[*]}"
  extra=()
  for pc in "${missing[@]}"; do
    owner=$(contents_lookup "usr/lib/loongarch64-linux-gnu/pkgconfig/$pc.pc")
    [ -n "$owner" ] || owner=$(contents_lookup "usr/lib/pkgconfig/$pc.pc")
    if [ -z "$owner" ]; then
      log "  警告: Contents 中找不到 $pc.pc 的属主，跳过"
      continue
    fi
    log "  反查补包: $pc.pc ← $owner"
    extra+=("$owner")
  done
  [ ${#extra[@]} -eq 0 ] && die "无法定位缺失 .pc 的属主: ${missing[*]}"
  expand_deps "${extra[@]}"
done

# --- 最终校验 ------------------------------------------------------------------
failed=()
for pc in "${REQUIRED_PC[@]}"; do
  pkg-config --exists "$pc" 2>/dev/null || failed+=("$pc")
done
if [ ${#failed[@]} -gt 0 ]; then
  printf 'pkg-config 搜索路径:\n  %s\n' "${PKGCONFIG_DIRS[*]}" >&2
  die "关键 .pc 缺失: ${failed[*]}"
fi

log "全部关键 .pc 就绪: ${REQUIRED_PC[*]}"

# 跳过的包多为 loong64 移植源里不存在的 gir1.2-*-dev（GIR 描述，交叉编译不链接），
# 列出以备核对，但不影响构建。
if [ ${#SKIPPED[@]} -gt 0 ]; then
  log "跳过 ${#SKIPPED[@]} 个索引中不存在的依赖包（多为 GIR 描述，交叉编译不需要）"
fi

# 架构校验：逐个检查 sysroot 里的关键 .so 真的是 LoongArch。
# 比“有没有 x86_64 目录”更可靠——交叉链接最危险的失败模式是把宿主 amd64 的
# 库链进 LoongArch 产物，而那不会留下明显的目录痕迹。
for so in libwebkit2gtk-4.1.so.0 libgtk-3.so.0 libsoup-3.0.so.0 libssl.so.3 libcrypto.so.3; do
  hit=$(find "$SYSROOT" -name "${so}*" -type f | head -1)
  [ -n "$hit" ] || die "sysroot 缺少 $so"
  if command -v readelf >/dev/null; then
    readelf -h "$hit" | grep -q 'Machine:.*LoongArch' \
      || die "$so 不是 LoongArch（$(readelf -h "$hit" | grep Machine)）: $hit"
  fi
done
log "架构校验通过: 关键运行时库均为 LoongArch"

# Debian multiarch 布局下，部分架构相关头（opensslconf.h、asm/*.h 等）只存在于
# usr/include/<triple>/ 子目录，而 pkg-config 只发 -I$sysroot/usr/include。
# 缺了这一层，-sys crate 会在 cargo 阶段报「No such file or directory」。
# 由调用方把该目录加入 C_INCLUDE_PATH（见 release.yml的 Export cross-compile
# environment 步骤）；此处只校验它存在，不做逐文件软链——软链要跟着
# configuration.h 之类的链式包含逐个补，漏一个就又炸。
# 注意：Debian 的 multiarch 元组（loongarch64-linux-gnu）与 Rust/工具链三元组
# （loongarch64-unknown-linux-gnu）不同名，这里必须用前者。
MULTIARCH_INC="$SYSROOT/usr/include/$DEB_ARCH"
[ -d "$MULTIARCH_INC" ] || die "multiarch 头目录不存在: $MULTIARCH_INC"
log "multiarch 头目录就绪: $MULTIARCH_INC"

# 链接期同样需要它：glibc 的 libc.so 是 GNU ld script，内部写的是绝对路径
# /lib64/libc.so.6、/usr/lib64/libc_nonshared.a，不带 --sysroot 时 ld 找不到。
for d in "$SYSROOT/lib64" "$SYSROOT/usr/lib64"; do
  [ -d "$d" ] || die "glibc 链接目录不存在: $d（工具链 sysroot 拷贝失败？）"
done

printf '%s\n' "$SYSROOT"