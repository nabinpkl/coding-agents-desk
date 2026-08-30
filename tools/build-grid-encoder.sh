#!/bin/sh
# The one compiled piece of the live-tile path. Built once and spawned per
# request by the sidecar, so changing the TypeScript around it never waits on a
# Swift build and never needs a host relaunch.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/.build/grid-encoder"
mkdir -p "$root/.build"
swiftc -O \
  "$root/tools/grid-encoder/main.swift" \
  "$root/tools/grid-encoder/PointerInput.swift" \
  -o "$out"
echo "built $out"
