#!/usr/bin/env bash
# Deterministic content hash of the given files/dirs, used to gate rebuilds
# (mirrors the shasum idiom in `build_pty_manager_if_changed`). Order- and
# mtime-independent: it hashes file contents + paths, so a checkout or `touch`
# does not change the result. Vendor/build-output directories are pruned.
#
# Missing inputs contribute nothing. The failure mode is biased safe: an
# un-pruned output dir merely keeps changing the hash (=> always rebuild, the
# current behavior), never a false skip that would ship stale code. Only known
# vendor/output directory NAMES are pruned, never hand-edited source.
set -euo pipefail

emit() {
    local p="$1"
    if [ -f "$p" ]; then
        shasum -a 256 "$p"
    elif [ -d "$p" ]; then
        find "$p" -type d \( \
            -name node_modules -o -name .git -o -name .venv -o -name __pycache__ \
            -o -name target -o -name dist -o -name webview-dist \
            -o -name gesture-webview-dist -o -name embed-public -o -name .next \
            -o -name coverage \
            \) -prune -o -type f ! -name '.DS_Store' -print0 \
            | LC_ALL=C sort -z | xargs -0 shasum -a 256 2>/dev/null
    fi
}

{ for p in "$@"; do emit "$p"; done; } | LC_ALL=C sort | shasum -a 256 | awk '{ print $1 }'
