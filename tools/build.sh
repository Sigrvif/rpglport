#!/usr/bin/env bash
# Build the distributable RPGLPort bundle (spec §3.4, §12).
# Usage: ./tools/build.sh [x64|arm64]   (default x64; arm64 = host-only pool)
set -euo pipefail
cd "$(dirname "$0")/.."
ARCH="${1:-x64}"
LADDER="0.12.3 0.19.5 0.22.3 0.29.0 0.39.3 0.48.4"
WORK="dist/build"
OUT="dist/RPGLPort"
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

# 2. app + manifest + 7zz (+ its license)
VERSION=$(node -p "require('./package.json').version")
cp -a app "$OUT/app"
cp package.json "$OUT/package.json"   # NW manifest (main/window) — without it nw . shows a blank window
cp README.md "$OUT/README.md"         # user-facing readme
cp LICENSE "$OUT/LICENSE"             # the tool's own MIT license
mkdir -p "$OUT/bin" "$OUT/licenses/7-Zip" "$OUT/licenses/NW.js" "$OUT/licenses/Chromium"
curl -fsSL "https://www.7-zip.org/a/7z2602-linux-x64.tar.xz" -o "$WORK/7z.tar.xz"
tar -xJf "$WORK/7z.tar.xz" -C "$WORK" 7zz License.txt
mv "$WORK/7zz" "$OUT/bin/7zz"
mv "$WORK/License.txt" "$OUT/licenses/7-Zip/License.txt"
# NW.js (MIT) + Chromium (BSD-3) license texts, vendored snapshots from upstream
cp tools/licenses/LICENSE.nwjs "$OUT/licenses/NW.js/LICENSE.txt"
cp tools/licenses/LICENSE.chromium "$OUT/licenses/Chromium/LICENSE.txt"
chmod +x "$OUT/bin/7zz"
# real credits replace the NW.js tarball's sample placeholder page
cp app/credits-template.html "$OUT/credits.html"

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
node -e "const fs=require('fs');const l='$LADDER'.split(' ');fs.writeFileSync('$OUT/build.json',JSON.stringify({version:'$VERSION',host:'$HOST',arch:'$ARCH',ladder:l,mapSnapshot:JSON.parse(fs.readFileSync('app/core/nwmap.json')).generated,built:new Date().toISOString()},null,2))"
cat > "$OUT/RPGLPort.sh" <<'EOF'
#!/bin/sh
cd "$(dirname "$0")"
# LD_LIBRARY_PATH alongside the binary's rpath — standard portable-bundle practice
export LD_LIBRARY_PATH="$PWD/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec ./nw . "$@"
EOF
chmod +x "$OUT/RPGLPort.sh"

# 5. selftest the assembled bundle (uses OUT as bundle root)
( cd "$OUT" && node -e "
const { selftest } = require('./app/core/engine');
selftest(process.cwd()).then(r => {
  for (const c of r.checks) console.log((c.ok?'PASS':'FAIL'), c.name, c.detail||'');
  process.exit(r.ok ? 0 : 1);
});" ) || { echo "bundle selftest failed"; exit 1; }

# 6. package (versioned name)
ART="RPGLPort-${VERSION}-linux-${ARCH}.tar.xz"
tar -cJf "dist/$ART" -C dist RPGLPort
( cd dist && sha256sum "$ART" > "$ART.sha256" )
rm -rf "$WORK"
echo "built dist/$ART"
