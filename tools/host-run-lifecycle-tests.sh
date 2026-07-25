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

stable_release="$(just --dry-run host-run stable 2>&1)"
assert_contains "$stable_release" \
    '/Build/Products/Debug/AgentDeskHost.app/Contents/MacOS/AgentDeskHost' \
    'Release launch must kill an existing stable Debug host'
assert_contains "$stable_release" \
    '/Build/Products/Release/AgentDeskHost.app/Contents/MacOS/AgentDeskHost' \
    'Release launch must kill an existing stable Release host'
assert_contains "$stable_release" \
    'lsof -nP -iUDP:"$SIGPORT" -t' \
    'QUIC signaling owner must be discovered over UDP'
assert_contains "$stable_release" \
    'FEEDPORT=7682' \
    'stable launch must target the stable agent-feed port'
assert_contains "$stable_release" \
    'lsof -nP -iTCP:"$FEEDPORT" -sTCP:LISTEN -t' \
    'stable launch must discover a stale agent-feed sidecar listener'
assert_contains "$stable_release" \
    'agent-feed sidecar port $FEEDPORT is held by a non-AgentDesk process' \
    'stable launch must refuse to kill a non-AgentDesk feed-port owner'
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
    'lsof -nP -iUDP:"$SIGPORT" -t' \
    'dev QUIC signaling owner must be discovered over UDP'
assert_contains "$dev_debug" \
    'FEEDPORT=7782' \
    'dev launch must target the dev agent-feed port'
assert_contains "$dev_debug" \
    'lsof -nP -iTCP:"$FEEDPORT" -sTCP:LISTEN -t' \
    'dev launch must discover a stale agent-feed sidecar listener'
assert_contains "$dev_debug" \
    'agent-feed sidecar port $FEEDPORT is held by a non-AgentDesk process' \
    'dev launch must refuse to kill a non-AgentDesk feed-port owner'
assert_contains "$dev_debug" \
    'ERROR: newly built host did not launch' \
    'dev launch must fail when the exact new executable is absent'

printf 'host run lifecycle tests passed\n'
