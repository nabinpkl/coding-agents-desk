#!/usr/bin/env sh
set -eu

# Print this Mac's MagicDNS name, without the trailing dot.
#
# This is the one name the panel's dev server can be reached by from BOTH surfaces, and the reason
# it has to be a name at all rather than the tailnet IP: the phone refuses cleartext HTTP to a
# tailnet address (App Transport Security does not count 100.64/10 as local networking), so the dev
# server has to speak TLS, and a certificate is issued to a name. Tailscale issues a publicly
# trusted one for exactly this name, which is what makes the phone's HMR loop possible with no ATS
# exception in a client that ships to a daily driver.
#
# Derived, never written down: it is per-machine and per-tailnet, so a literal here would be one
# person's checkout.

if ! command -v tailscale >/dev/null 2>&1; then
    echo "ERROR: tailscale is not on PATH, so the panel dev server has no name to be reached by." >&2
    exit 1
fi

name="$(
    tailscale status --json 2>/dev/null |
        /usr/bin/python3 -c 'import json,sys
try:
    print((json.load(sys.stdin)["Self"]["DNSName"] or "").rstrip("."))
except Exception:
    pass'
)"

if [ -z "$name" ]; then
    echo "ERROR: no MagicDNS name for this machine. Is tailscaled running, and MagicDNS enabled" >&2
    echo "       for this tailnet? 'tailscale status' is the place to look." >&2
    exit 1
fi

printf '%s\n' "$name"
