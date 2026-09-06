#!/bin/sh
# A second agent-feed sidecar, on its own port, running from source under
# `bun --watch` so a TypeScript edit is live in about four seconds with the pid
# unchanged. This is the fast loop for work on the sidecar itself.
#
# Deliberately NOT the host's sidecar: `just host-run` owns 7682 (7782 for the
# dev tier) and starting a second listener there would fight it. This one binds
# AGENT_FEED_PARK_DEV_PORT, default 7690, and the running host never notices.
#
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
port="${AGENT_FEED_PARK_DEV_PORT:-7690}"

umask 077

bun="$(command -v bun || true)"
if [ -z "$bun" ]; then
  echo "park-sidecar-dev: no bun on PATH" >&2
  exit 1
fi

echo "park sidecar dev: http://127.0.0.1:$port"
echo "try: curl -sS http://127.0.0.1:$port/api/park/state"

AGENT_FEED_PORT="$port" \
exec "$bun" --watch "$root/agent-feed/sidecar/src/server.ts"
