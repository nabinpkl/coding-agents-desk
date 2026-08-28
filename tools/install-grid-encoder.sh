#!/bin/sh
set -eu
root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
candidate="$root/.build/grid-encoder"
destination="$(node "$root/tools/runtime-paths.mjs" grid-encoder)"
sh "$root/tools/build-grid-encoder.sh" "$candidate"
node "$root/tools/build-system/install-runtime.mjs" helper "$candidate" "$destination"
