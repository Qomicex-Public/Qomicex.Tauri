#!/bin/sh
set -e
SRCDIR="$(realpath "$(dirname "$0")/..")"
NAME="$(basename "$SRCDIR")"
cd "$SRCDIR"

npx tsc && npx vite build

OUTDIR="$SRCDIR/dist/pkg"
mkdir -p "$OUTDIR"
zip -r "$OUTDIR/${NAME}.qplugin" \
  manifest.json dist/ \
  -x "dist/pkg/*" -x ".git/*"
