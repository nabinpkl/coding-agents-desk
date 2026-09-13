#!/bin/sh
set -eu

# Every declared peer's sidecar, kept running and kept current, as a supervised job.
#
# Its own LaunchAgent for the same reason `panel-dev-login.sh` is: launchd reaps a job's process
# group when that job exits, so anything that has to outlive its starter has to BE a job. And for
# the same reason it earns KeepAlive -- a watcher that dies at 3am comes back on its own rather
# than leaving a peer quietly serving whatever it had when the watcher stopped.
#
# The failure this exists to end: a peer's sidecar runs under `bun --watch`, so it re-reads its own
# sources four seconds after they change -- but they only change when somebody ships, and nobody
# remembers to. Measured 2026-09-13 on the oracle peer: up two days and four hours, with a shipped
# tree two days old, answering /api/config the whole time. A stale runtime is indistinguishable
# from a current one until something asks it for a feature it does not have, which is exactly what
# this Mac's own launchd path used to do with the frozen bundled sidecar.
#
# Deliberately thin. Which peers, and what to do about each, is `just remote-sidecar-watch-all`, so
# the login path and a hand-run one are the same code rather than two that drift.
PATH="${PATH:-}:/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

echo "=== remote-sidecar-login $(date -u '+%Y-%m-%dT%H:%M:%SZ') repo=$REPO"
exec just remote-sidecar-watch-all
