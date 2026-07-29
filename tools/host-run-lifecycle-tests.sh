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

printf 'host run lifecycle tests passed\n'
