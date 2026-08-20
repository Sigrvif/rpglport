#!/usr/bin/env bash
# Build the distributable RPGPort bundle (spec §3.4, §12).
# Usage: ./tools/build.sh [x64|arm64]   (default x64; arm64 = host-only pool)
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH="${1:-x64}"
LADDER="0.12.3 0.19.5 0.22.3 0.29.0 0.48.4"
WORK="dist/build"
OUT="dist/RPGPort"
rm -rf "$WORK" "$OUT" && mkdir -p "$WORK" "$OUT" dist

# 0. versions.json (fetch if missing so any connected machine can build)
if [ ! -s tools/versions.json ]; then
  curl -fsSL https://nwjs.io/versions.json -o tools/versions.json
fi

# 0.5. embed a fresh nwmap (spec §12)
node tools/gen-nwmap.js tools/versions.json

# 1. host runtime (latest stable NW.js for the target arch)
HOST=$(node -e "console.log(JSON.parse(require('fs').readFileSync('tools/versions.json')).versions[0].version)")
curl -fsSL "https://dl.nwjs.io/${HOST}/nwjs-${HOST}-linux-${ARCH}.tar.gz" -o "$WORK/host.tar.gz"
tar -xzf "$WORK/host.tar.gz" -C "$WORK"
HOSTDIR=$(basename "$WORK"/nwjs-*)
node tools/verify-runtime.cjs "$WORK/$HOSTDIR" --allow-unnamed || { echo "host runtime failed verification"; exit 1; }
rm -rf "$OUT" && mv "$WORK/$HOSTDIR" "$OUT"
rm "$WORK/host.tar.gz"

# 2. app + tools + 7zz
cp -a app "$OUT/app"
mkdir -p "$OUT/bin" "$OUT/tools"
curl -fsSL "https://www.7-zip.org/a/7z2602-linux-x64.tar.xz" -o "$WORK/7z.tar.xz"
tar -xJf "$WORK/7z.tar.xz" -C "$WORK" 7zz && mv "$WORK/7zz" "$OUT/bin/7zz"
chmod +x "$OUT/bin/7zz"

# 3. ladder runtimes (x64 only; arm64 bundle = host + imports per spec)
if [ "$ARCH" = "x64" ]; then
  mkdir -p "$OUT/runtimes"
  for v in $LADDER; do
    curl -fsSL "https://dl.nwjs.io/v${v}/nwjs-v${v}-linux-x64.tar.gz" -o "$WORK/nw.tar.gz"
    tar -xzf "$WORK/nw.tar.gz" -C "$OUT/runtimes"
    node tools/verify-runtime.cjs "$OUT/runtimes/nwjs-v${v}-linux-x64" || { echo "runtime $v failed verification"; exit 1; }
  done
fi

# 4. build.json + launcher
node -e "const fs=require('fs');const l='$LADDER'.split(' ');fs.writeFileSync('$OUT/build.json',JSON.stringify({host:'$HOST',arch:'$ARCH',ladder:l,mapSnapshot:JSON.parse(fs.readFileSync('app/core/nwmap.json')).generated,built:new Date().toISOString()},null,2))"
cat > "$OUT/RPGPort.sh" <<'EOF'
#!/bin/sh
cd "$(dirname "$0")"
exec ./nw . "$@"
EOF
chmod +x "$OUT/RPGPort.sh"

# 5. selftest the assembled bundle (uses OUT as bundle root)
( cd "$OUT" && node -e "
const { selftest } = require('./app/core/engine');
selftest(process.cwd()).then(r => {
  for (const c of r.checks) console.log((c.ok?'PASS':'FAIL'), c.name, c.detail||'');
  process.exit(r.ok ? 0 : 1);
});" ) || { echo "bundle selftest failed"; exit 1; }

# 6. package
STAMP=$(date +%Y%m%d)
tar -cJf "dist/RPGPort-linux-${ARCH}-${STAMP}.tar.xz" -C dist RPGPort
( cd dist && sha256sum "RPGPort-linux-${ARCH}-${STAMP}.tar.xz" > "RPGPort-linux-${ARCH}-${STAMP}.tar.xz.sha256" )
rm -rf "$WORK"
echo "built dist/RPGPort-linux-${ARCH}-${STAMP}.tar.xz"
