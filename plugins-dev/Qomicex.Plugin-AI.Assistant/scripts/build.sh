#!/bin/sh
set -e
SRCDIR="$(realpath "$(dirname "$0")/..")"
NAME="$(basename "$SRCDIR")"
cd "$SRCDIR"

npm run build

OUTDIR="$SRCDIR/dist/pkg"
mkdir -p "$OUTDIR"
rm -f "$OUTDIR/${NAME}.qplugin"
zip -r "$OUTDIR/${NAME}.qplugin" \
  manifest.json dist/ \
  -x "dist/pkg/*" -x ".git/*" -x "src/*" -x "node_modules/*"

echo "Packaged: $OUTDIR/${NAME}.qplugin"
