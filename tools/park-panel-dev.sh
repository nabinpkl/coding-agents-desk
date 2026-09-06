#!/bin/sh
# The Agent Panel's Vite dev server for park work, pointed at one of the two
# sidecars by argument.
#
#   dev  (default)  tools/park-sidecar-dev.sh on 7690. Fast to restart, but it
#                   is spawned outside the running host's process tree, so any
#                   helper IT spawns has no Screen Recording grant and window
#                   capture comes back "not shareable".
#   host            the sidecar the running host spawned, on 7682. Inherits the
#                   host's TCC, so capture works. This is the one to use for
#                   anything involving pixels.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
which="${1:-dev}"

case "$which" in
  host)
    port="${AGENT_FEED_PORT_HOST:-7682}"
    panel_port="${AGENTDESK_PARK_PANEL_PORT:-5185}"
    ;;
  dev)
    port="${AGENT_FEED_PARK_DEV_PORT:-7690}"
    panel_port="${AGENTDESK_PARK_PANEL_PORT:-5184}"
    ;;
  *)
    echo "park-panel-dev: expected 'dev' or 'host', got '$which'" >&2
    exit 1
    ;;
esac

echo "park panel dev ($which): http://127.0.0.1:$panel_port -> sidecar 127.0.0.1:$port"
AGENTDESK_AGENT_FEED_ORIGIN="http://127.0.0.1:$port" \
exec bun run --cwd "$root/packages/AgentPanel/Web" vite --port "$panel_port"
