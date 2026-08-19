#!/usr/bin/env bash
# Fetch dev dependencies: static 7zz, host NW.js runtime, ladder runtimes.
# Reuses cached files in $RPGPORT_DL_CACHE (default /tmp/kilo) to stay offline-friendly.
set -euo pipefail
cd "$(dirname "$0")/.."
CACHE="${RPGPORT_DL_CACHE:-/tmp/kilo}"
mkdir -p "$CACHE" bin runtimes _host

fetch() { # fetch <url> <dest>
  local url="$1" dest="$2"
  if [ -s "$dest" ]; then echo "cached: $dest"; return 0; fi
  # try cache by basename first
  if [ -s "$CACHE/$(basename "$url")" ]; then cp "$CACHE/$(basename "$url")" "$dest"; return 0; fi
  echo "downloading: $url"
  curl -fL --retry 2 -o "$dest" "$url"
  cp "$dest" "$CACHE/$(basename "$url")"
}

# 1. Static 7-Zip (zip/7z/rar in one binary)
fetch "https://www.7-zip.org/a/7z2602-linux-x64.tar.xz" "$CACHE/7z-linux-x64.tar.xz"
tar -xJf "$CACHE/7z-linux-x64.tar.xz" -C bin 7zz && chmod +x bin/7zz
bin/7zz i | head -2 || true

# 2. versions.json (map source) — reuse cache if present
if [ ! -s "$CACHE/nwjs-versions.json" ]; then
  curl -fsSL https://nwjs.io/versions.json -o "$CACHE/nwjs-versions.json"
fi
cp "$CACHE/nwjs-versions.json" tools/versions.json

# 3. Host NW.js (latest stable) — GUI host + newest pool entry
LATEST=$(node -e "console.log(JSON.parse(require('fs').readFileSync('tools/versions.json')).versions[0].version)")
fetch "https://dl.nwjs.io/${LATEST}/nwjs-${LATEST}-linux-x64.tar.gz" "$CACHE/host-nwjs.tar.gz"
rm -rf _host && mkdir -p _host
tar -xzf "$CACHE/host-nwjs.tar.gz" -C _host --strip-components=1

# 4. Ladder runtimes (same list as build.sh)
LADDER="0.12.3 0.19.5 0.22.3 0.29.0 0.48.4"
for v in $LADDER; do
  if [ -d "runtimes/nwjs-v${v}-linux-x64" ]; then continue; fi
  # reuse pre-extracted cache dirs when available (e.g. /tmp/kilo/nwjs-v0.29.0-linux-x64)
  if [ -d "$CACHE/nwjs-v${v}-linux-x64" ]; then
    cp -a "$CACHE/nwjs-v${v}-linux-x64" "runtimes/"
  else
    fetch "https://dl.nwjs.io/v${v}/nwjs-v${v}-linux-x64.tar.gz" "$CACHE/nwjs-v${v}.tar.gz"
    tar -xzf "$CACHE/nwjs-v${v}.tar.gz" -C runtimes
  fi
done
# 5. Host admission in dev: repo root must look like a runtime root (nw + lib/).
#    Symlinks keep the dev layout valid for listPool()/selftest() without committing 200 MB.
ln -sfn _host/nw nw
ln -sfn _host/lib lib
ls runtimes/
echo "dev deps ready"
