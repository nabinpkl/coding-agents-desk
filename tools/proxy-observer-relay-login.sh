#!/bin/sh
set -eu

# The proxy-agent observer relay, as a supervised job.
#
# Its own LaunchAgent for the reason `panel-dev-login.sh` and `remote-sidecar-login.sh` are: launchd
# reaps a job's process group when that job exits, so anything that has to outlive its starter has
# to BE a job. KeepAlive for the same reason they have it -- a relay that dies at 3am comes back on
# its own rather than leaving every peer's mirror silently absent, which is a state nothing reports.
#
# What it is for: a peer's sidecar mirrors Claude's live network traffic by subscribing to
# proxy-agent's observer API, and that API is this Mac's alone. Without this running, a peer points
# at its own loopback, finds nothing there, and shows no mirror at all -- and a sidecar with no
# mirror looks exactly like a sidecar whose sessions happen to be quiet.
#
# Deliberately thin, like its siblings: what the relay IS lives in `just proxy-observer-relay`, so
# the login path and a hand-run one are the same code rather than two that drift.
PATH="${PATH:-}:/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

echo "=== proxy-observer-relay-login $(date -u '+%Y-%m-%dT%H:%M:%SZ') repo=$REPO"
exec just proxy-observer-relay
