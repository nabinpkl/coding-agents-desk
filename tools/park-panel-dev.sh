#!/bin/sh
# The Agent Panel's Vite dev server, pointed at the park dev sidecar rather than
# the host's. Pairs with tools/park-sidecar-dev.sh: that one binds 7690 and mints
# the token, this one proxies /api there and attaches it.
#
# A separate port and a separate script so neither the running host's sidecar nor
# the panel dev server a host launch would start is disturbed.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
sidecar_port="${AGENT_FEED_PARK_DEV_PORT:-7690}"
token_file="$root/.build/agent-park-dev/control-token"

if [ ! -s "$token_file" ]; then
  echo "park-panel-dev: no token at $token_file; start tools/park-sidecar-dev.sh first" >&2
  exit 1
fi

echo "park panel dev: http://127.0.0.1:${AGENTDESK_PARK_PANEL_PORT:-5184} -> sidecar 127.0.0.1:$sidecar_port"
AGENTDESK_AGENT_FEED_ORIGIN="http://127.0.0.1:$sidecar_port" \
AGENT_FEED_CONTROL_TOKEN="$(cat "$token_file")" \
exec bun run --cwd "$root/packages/AgentPanel/Web" vite --port "${AGENTDESK_PARK_PANEL_PORT:-5184}"
