#!/bin/sh
# One-command install for the tailnet-only pf rules.
#
# Run from anywhere, as yourself: `tools/pf-tailnet-only-install.sh`
# It re-execs under sudo (you type your password once), then:
#   1. installs root-owned copies of the anchor (/etc/pf.anchors/agentdesk-tailnet-only) and of
#      the loader (/Library/PrivilegedHelperTools/agentdesk-pf-tailnet-only.sh),
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
# The boot job runs as root, so everything it reads is a root-owned copy made here. Pointing it at
# the checkout would let anything that can edit the checkout run as root at the next boot, and set
# the firewall rules. /Library/PrivilegedHelperTools, not /usr/local, which Homebrew on Intel hands
# to the user.
HELPERS="/Library/PrivilegedHelperTools"
LOADER_DST="$HELPERS/agentdesk-pf-tailnet-only.sh"
LOG="/var/log/agentdesk-pf.log"
LABEL="agentdesk.pf-tailnet-only"
PLIST_DST="/Library/LaunchDaemons/$LABEL.plist"

[ -d "$HELPERS" ] || install -d -o root -g wheel -m 755 "$HELPERS"
install -o root -g wheel -m 644 "$ANCHOR_SRC" "$ANCHOR_DST"
install -o root -g wheel -m 755 "$REPO/tools/pf-tailnet-only.sh" "$LOADER_DST"
# Loading lives in the loader, and install time runs the same installed copy the boot job runs, so
# the two can never drift apart.
sh "$LOADER_DST" "$ANCHOR_DST"

# Re-applies the tailnet-only anchor at boot: anchor contents do not persist across restarts. The
# plist is written here rather than checked in, and built with plutil; -create replaces a previous
# copy.
plutil -create xml1 "$PLIST_DST"
plutil -insert Label -string "$LABEL" "$PLIST_DST"
plutil -insert ProgramArguments -array "$PLIST_DST"
plutil -insert ProgramArguments.0 -string /bin/sh "$PLIST_DST"
plutil -insert ProgramArguments.1 -string "$LOADER_DST" "$PLIST_DST"
plutil -insert ProgramArguments.2 -string "$ANCHOR_DST" "$PLIST_DST"
plutil -insert RunAtLoad -bool true "$PLIST_DST"
# Root writes the log, so it goes under /var/log: a fixed name in /tmp is a symlink anyone can plant.
plutil -insert StandardOutPath -string "$LOG" "$PLIST_DST"
plutil -insert StandardErrorPath -string "$LOG" "$PLIST_DST"
plutil -lint "$PLIST_DST" >/dev/null
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
