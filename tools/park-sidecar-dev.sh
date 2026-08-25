#!/bin/sh
# A second agent-feed sidecar, on its own port, running from source under
# `bun --watch` so a TypeScript edit is live in about four seconds with the pid
# unchanged. This is the fast loop for work on the sidecar itself.
#
# Deliberately NOT the host's sidecar: `just host-run` owns 7682 (7782 for the
# dev tier) and starting a second listener there would fight it. This one binds
# AGENT_FEED_PARK_DEV_PORT, default 7690, and the running host never notices.
#
# The bearer token is minted into a 0600 file under `.build/`, which is
# gitignored, rather than living in `.claude/launch.json`, which is tracked.
# Same shape as the panel dev server's control token, and the same cost applies:
# while this is up, anything running as this user can read that file and drive
# this sidecar's API. It is a development instance on loopback; the host's own
# sidecar still mints its own token in memory.
set -eu

root="$(cd "$(dirname "$0")/.." && pwd)"
port="${AGENT_FEED_PARK_DEV_PORT:-7690}"
token_dir="$root/.build/agent-park-dev"
token_file="$token_dir/control-token"

mkdir -p "$token_dir"
if [ ! -s "$token_file" ]; then
  umask 077
  # 32 bytes of urandom, hex. No dependency on openssl being present.
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$token_file"
fi
chmod 600 "$token_file"

bun="$(command -v bun || true)"
if [ -z "$bun" ]; then
  echo "park-sidecar-dev: no bun on PATH" >&2
  exit 1
fi

echo "park sidecar dev: http://127.0.0.1:$port"
echo "token file: $token_file"
echo "try: curl -sS -H \"Authorization: Bearer \$(cat $token_file)\" http://127.0.0.1:$port/api/park/state"

AGENT_FEED_PORT="$port" \
AGENT_FEED_CONTROL_TOKEN="$(cat "$token_file")" \
exec "$bun" --watch "$root/agent-feed/sidecar/src/server.ts"
