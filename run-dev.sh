#!/usr/bin/env bash
# Launch the RPGPort GUI in dev mode: project root is the NW app root.
set -euo pipefail
cd "$(dirname "$0")"
if [ ! -x _host/nw ]; then echo "run tools/fetch-dev-deps.sh first" >&2; exit 1; fi
exec ./_host/nw .
