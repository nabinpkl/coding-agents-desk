#!/bin/sh
set -eu

# The tailnet launcher page (https://<this-mac>.ts.net/), as a supervised job.
#
# `tailscale serve` persists its 443 -> http://127.0.0.1:8080 mapping across
# restarts, but the python server behind it does not: `just tailnet-apps` is a
# foreground process, so the homepage 502s after any reboot or killed terminal
# while the serve config keeps pointing at an empty port (measured 2026-09-19).
# Its own LaunchAgent for the same reason `panel-dev-login.sh` is one: launchd
# reaps a job's process group when that job exits, so anything that has to
# outlive its starter has to BE a job. KeepAlive brings it back if it dies.
#
# Deliberately thin. What it serves, and on which port, is `just tailnet-apps`,
# so the login path and a hand-run one are the same code rather than two that
# drift.
PATH="${PATH:-}:/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

echo "=== tailnet-apps-login $(date -u '+%Y-%m-%dT%H:%M:%SZ') repo=$REPO"
exec just tailnet-apps
