#!/bin/sh
# Load the tailnet-only pf rules without flushing anything else.
#
# `pfctl -a <anchor> -f <file>` merges into the running ruleset; unlike
# `pfctl -f /etc/pf.conf` it never drops the dynamic anchors running
# services (Internet Sharing, Application Firewall) hold. Run with sudo;
# the LaunchDaemon below runs it as root at boot for the same reason.
#
# The rules file is the first argument: the installer and the boot job pass the root-owned copy in
# /etc/pf.anchors. Run by hand from a checkout, it defaults to that checkout's rules.
set -eu

ANCHOR="com.apple/agentdesk"
SRC="${1:-$(cd "$(dirname "$0")" && pwd)/pf-tailnet-only/anchor.conf}"

# Drop the superseded top-level anchor if a previous install left it behind.
# `-F rules` flushes inside that anchor only; the main ruleset is untouched.
pfctl -a "agentdesk.tailnetonly" -F rules 2>/dev/null || true
pfctl -a "$ANCHOR" -f "$SRC"
pfctl -e 2>/dev/null || true  # already enabled is fine
echo "--- $ANCHOR now ---"
pfctl -a "$ANCHOR" -s rules
