#!/bin/sh
set -eu

# The login launch's entry point, run by the `*.devlogin` LaunchAgent.
#
# It exists because a login job inherits launchd's environment, which has no PATH worth the name.
# The agent's own plist carries the real one, captured by `just dev-login-install` from a shell that
# could still resolve the toolchain: `just` under ~/.local/bin, `node` inside an nvm version
# directory, `bun` in Homebrew, `tailscale` in /usr/local. The fallback below is only for a hand-run
# of this script, and is not expected to be the one that works.
#
# Deliberately thin. Everything it knows is in `just host-login`, so the login path and a hand-run
# one are the same code rather than two that drift.
PATH="${PATH:-}:/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

echo "=== dev-login $(date -u '+%Y-%m-%dT%H:%M:%SZ') repo=$REPO"
exec just host-login
