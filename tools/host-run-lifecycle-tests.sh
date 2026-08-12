#!/usr/bin/env sh
set -eu

assert_contains() {
    output="$1"
    expected="$2"
    description="$3"
    if ! printf '%s\n' "$output" | grep -Fq "$expected"; then
        printf 'host run lifecycle test failed: %s\nmissing: %s\n' \
            "$description" "$expected" >&2
        exit 1
    fi
}

assert_not_contains() {
    output="$1"
    unexpected="$2"
    description="$3"
    if printf '%s\n' "$output" | grep -Fq "$unexpected"; then
        printf 'host run lifecycle test failed: %s\nunexpected: %s\n' \
            "$description" "$unexpected" >&2
        exit 1
    fi
}

stable_release="$(just --dry-run host-run stable 2>&1)"
assert_contains "$stable_release" \
    '/Build/Products/Debug/AgentDeskHost.app/Contents/MacOS/AgentDeskHost' \
    'Release launch must kill an existing stable Debug host'
assert_contains "$stable_release" \
    '/Build/Products/Release/AgentDeskHost.app/Contents/MacOS/AgentDeskHost' \
    'Release launch must kill an existing stable Release host'
assert_contains "$stable_release" \
    'sh tools/local-udp-port-pids.sh "$SIGPORT"' \
    'QUIC signaling owner discovery must inspect the local UDP endpoint'
assert_not_contains "$stable_release" \
    'lsof -nP -iUDP:"$SIGPORT" -t' \
    'QUIC signaling owner discovery must not include remote UDP endpoints'
assert_contains "$stable_release" \
    'FEEDPORT=7682; VOICEPORT=7692' \
    'stable launch must target the stable sidecar ports'
# Every loopback sidecar needs its port reclaimed, not just the first one that had the problem.
# Asserting only the agent feed is what let the voice server ship without this and leave an
# orphan holding its port across a host crash. What reclaiming does to a holder it does not
# recognize is tools/reclaim-port-tests.sh, against a real listener.
assert_contains "$stable_release" \
    'sh tools/reclaim-port.sh "agent-feed sidecar" "$FEEDPORT"' \
    'stable launch must reclaim the agent-feed port'
assert_contains "$stable_release" \
    'sh tools/reclaim-port.sh "voice sidecar" "$VOICEPORT"' \
    'stable launch must reclaim the voice sidecar port'
assert_not_contains "$stable_release" \
    'is held by a non-AgentDesk process' \
    'stable launch must not refuse to start over a port holder it does not recognize'
assert_contains "$stable_release" \
    'ERROR: newly built host did not launch' \
    'launch must fail when the exact new executable is absent'

dev_debug="$(just --dry-run host-run-dev dev false 2>&1)"
assert_contains "$dev_debug" \
    '/Build/Products/Debug/AgentDeskHost.app/Contents/MacOS/AgentDeskHost' \
    'Debug launch must kill an existing dev Debug host'
assert_contains "$dev_debug" \
    '/Build/Products/Release/AgentDeskHost.app/Contents/MacOS/AgentDeskHost' \
    'Debug launch must kill an existing dev Release host'
assert_contains "$dev_debug" \
    'sh tools/local-udp-port-pids.sh "$SIGPORT"' \
    'dev QUIC signaling discovery must inspect the local UDP endpoint'
assert_not_contains "$dev_debug" \
    'lsof -nP -iUDP:"$SIGPORT" -t' \
    'dev QUIC signaling discovery must not include remote UDP endpoints'
assert_contains "$dev_debug" \
    'FEEDPORT=7782; VOICEPORT=7792' \
    'dev launch must target the dev sidecar ports'
# Every loopback sidecar needs its port reclaimed, not just the first one that had the problem.
# Asserting only the agent feed is what let the voice server ship without this and leave an
# orphan holding its port across a host crash. What reclaiming does to a holder it does not
# recognize is tools/reclaim-port-tests.sh, against a real listener.
assert_contains "$dev_debug" \
    'sh tools/reclaim-port.sh "agent-feed sidecar" "$FEEDPORT"' \
    'dev launch must reclaim the agent-feed port'
assert_contains "$dev_debug" \
    'sh tools/reclaim-port.sh "voice sidecar" "$VOICEPORT"' \
    'dev launch must reclaim the voice sidecar port'
assert_not_contains "$dev_debug" \
    'is held by a non-AgentDesk process' \
    'dev launch must not refuse to start over a port holder it does not recognize'
assert_contains "$dev_debug" \
    'ERROR: newly built host did not launch' \
    'dev launch must fail when the exact new executable is absent'

# The live panel is the DEFAULT, on the Release daily driver as much as on the Debug twin. This is
# asserted on the substituted guard rather than on behaviour, because a dry run is the only place
# the chosen default is visible without launching a host. `panel` defaulting back to bundled would
# not fail anything else: the host would launch, the panel would load, and a TSX edit would simply
# stop reaching it -- the silent regression this exists to catch.
assert_contains "$stable_release" \
    "if [ 'live' = live ]" \
    'Release launch must serve the panel live by default'
assert_contains "$stable_release" \
    'just agent-webview-dev-ensure' \
    'a live panel launch must bring the dev server up first, not assume it'
assert_contains "$stable_release" \
    'export AGENTDESK_AGENT_PANEL_ORIGIN="http://127.0.0.1:5173"' \
    'a live panel launch must point the host at the dev server it started'
assert_contains "$dev_debug" \
    "if [ 'live' = live ]" \
    'Debug launch must serve the panel live by default'

bundled="$(just --dry-run host-run stable bundled 2>&1)"
assert_contains "$bundled" \
    "if [ 'bundled' = live ]" \
    'panel=bundled must leave the origin unset so the bundled webview is what loads'

printf 'host run lifecycle tests passed\n'
