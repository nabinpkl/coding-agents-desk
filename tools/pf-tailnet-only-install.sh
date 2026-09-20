#!/bin/sh
# One-command install for the tailnet-only pf rules.
#
# Run from anywhere, as yourself: `tools/pf-tailnet-only-install.sh`
# It re-execs under sudo (you type your password once), then:
#   1. installs the anchor to /etc/pf.anchors/agentdesk-tailnet-only,
#   2. merges it into the running pf set WITHOUT flushing anything else,
#   3. enables pf (no-op if already enabled),
#   4. installs + bootstraps the boot-persistence LaunchDaemon,
#   5. prints the live ruleset as proof.
# Re-running is safe: every step overwrites or reloads idempotently.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  exec sudo "$0" "$@"
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ANCHOR_SRC="$REPO/tools/pf-tailnet-only/anchor.conf"
ANCHOR_DST="/etc/pf.anchors/agentdesk-tailnet-only"
PLIST_SRC="$REPO/tools/pf-tailnet-only/com.example.agentdesk.agentdesk-pf.plist"
PLIST_DST="/Library/LaunchDaemons/com.example.agentdesk.agentdesk-pf.plist"

cp "$ANCHOR_SRC" "$ANCHOR_DST"
chmod 644 "$ANCHOR_DST"
# Loading lives in pf-tailnet-only.sh (the boot job runs the same file),
# so install-time and boot-time can never drift apart.
sh "$REPO/tools/pf-tailnet-only.sh"

cp "$PLIST_SRC" "$PLIST_DST"
chmod 644 "$PLIST_DST"
launchctl bootout "system/$PLIST_DST" 2>/dev/null || true  # already loaded is fine
launchctl bootstrap system "$PLIST_DST"

echo "--- pf status ---"
pfctl -s info | head -3
echo "--- self-check (loopback must still answer) ---"
curl -s -m 8 -o /dev/null -w "homepage :8080 -> %{http_code}\n" http://127.0.0.1:8080/
WIFI_IP="$(ipconfig getifaddr en0 2>/dev/null || echo '<wifi-ip>')"
TAILNET_DNS="$("$REPO/tools/tailnet-dns-name.sh" 2>/dev/null || echo '<this-mac>.ts.net')"
echo "LAN test from another device: http://${WIFI_IP}:5173/ must now refuse;"
echo "tailnet https://${TAILNET_DNS}:5173/ must still load."
