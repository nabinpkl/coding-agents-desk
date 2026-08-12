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
# The origin is taken FROM the step that brought the server up, rather than composed again here.
# Composed again is how the two drift: the scheme changed from http to https when the phone leg
# landed (ADR-0096), and a second spelling of the URL would have kept the old one working right up
# until it silently pointed at nothing.
assert_contains "$stable_release" \
    'export AGENTDESK_AGENT_PANEL_ORIGIN="$(just agent-webview-dev-ensure)"' \
    'a live panel launch must take its origin from the dev server it started'
assert_contains "$dev_debug" \
    "if [ 'live' = live ]" \
    'Debug launch must serve the panel live by default'

bundled="$(just --dry-run host-run stable bundled 2>&1)"
assert_contains "$bundled" \
    "if [ 'bundled' = live ]" \
    'panel=bundled must leave the origin unset so the bundled webview is what loads'

# The phone gets the same live panel, over the tailnet (ADR-0096). It reaches the client as an
# environment variable through devicectl, which is also what keeps it away from the daily driver:
# an app launched from the home screen has no environment to read. Asserting the CHILD prefix
# matters because without it devicectl keeps the variable for itself and the client sees nothing,
# which looks exactly like a client that ignored it.
for launch in 'pair-iphone stable' 'iphone-console-run stable'; do
    # shellcheck disable=SC2086
    phone="$(just --dry-run $launch 2>&1)"
    assert_contains "$phone" \
        "if [ 'live' = live ]" \
        "$launch must serve the panel live by default"
    assert_contains "$phone" \
        'DEVICECTL_CHILD_AGENTDESK_AGENT_PANEL_ORIGIN="$(just agent-webview-dev-ensure)"' \
        "$launch must pass the live origin to the client, under the devicectl child prefix"
    assert_contains "$phone" \
        '${PANEL_ENV[@]+"${PANEL_ENV[@]}"} xcrun devicectl' \
        "$launch must actually put the panel environment on the launch"
done

phone_bundled="$(just --dry-run pair-iphone stable bundled 2>&1)"
assert_contains "$phone_bundled" \
    "if [ 'bundled' = live ]" \
    'panel=bundled must leave the client on its own bundled webview'

printf 'host run lifecycle tests passed\n'
