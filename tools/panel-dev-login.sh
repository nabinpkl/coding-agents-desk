#!/bin/sh
set -eu

# The panel dev server, as a supervised job.
#
# `just host-login` does NOT start this one, and that is the point. A background child started by a
# launchd job dies when that job exits: measured 2026-09-10, the login launch reported "serving at
# https://...:5173" and the port was empty seconds later, because launchd reaps a job's process
# group on exit and `agent-webview-dev-ensure` detaches within it. A server that has to outlive its
# starter has to BE a job, which is also how it earns KeepAlive -- a Vite that dies at 3am comes
# back on its own instead of leaving a panel that cannot load.
#
# Foreground on purpose (`agent-webview-dev`, not `-ensure`): launchd supervises the process it
# starts, so the thing it starts must be the server itself.
PATH="${PATH:-}:/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

echo "=== panel-dev $(date -u '+%Y-%m-%dT%H:%M:%SZ') repo=$REPO"
exec just agent-webview-dev
