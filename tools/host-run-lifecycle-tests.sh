#!/usr/bin/env sh
set -eu

assert_contains() {
    output="$1"
    expected="$2"
    description="$3"
    if ! printf '%s\n' "$output" | grep -Fq -- "$expected"; then
        printf 'host run lifecycle test failed: %s\nmissing: %s\n' \
            "$description" "$expected" >&2
        exit 1
    fi
}

assert_not_contains() {
    output="$1"
    unexpected="$2"
    description="$3"
    if printf '%s\n' "$output" | grep -Fq -- "$unexpected"; then
        printf 'host run lifecycle test failed: %s\nunexpected: %s\n' \
            "$description" "$unexpected" >&2
        exit 1
    fi
}

stable_release="$(just --dry-run host-run stable 2>&1)"
assert_contains "$stable_release" \
    "APP='$(node tools/runtime-paths.mjs host-app "${AGENTDESK_HOST_BUNDLE_ID:-com.example.agentdesk.AgentDeskHost}")'" \
    'Release launch must use the stable installed app'
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
    "APP='$(node tools/runtime-paths.mjs host-app "${AGENTDESK_HOST_DEV_BUNDLE_ID:-com.example.agentdesk.AgentDeskHost.dev}")'" \
    'Debug launch must use the separate dev installed app'
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
    'PANEL_ORIGIN="$(just agent-webview-dev-ensure ' \
    'a live panel launch must take its origin from the dev server it started'
# The dev server proxies a plain browser tab to a sidecar, and which one is per host tier. Passing
# the resolved FEEDPORT rather than letting the recipe default keeps a browser tab pointed at the
# host that started the server instead of at whatever the stable tier happens to be.
assert_contains "$stable_release" \
    'just agent-webview-dev-ensure '"'"'5173'"'"' "http://127.0.0.1:$FEEDPORT"' \
    'a live panel launch must tell the dev server which sidecar to proxy to'
assert_contains "$dev_debug" \
    'just agent-webview-dev-ensure '"'"'5173'"'"' "http://127.0.0.1:$FEEDPORT"' \
    'the dev launch must tell the dev server which sidecar to proxy to'
# The two-step assign-then-export is load-bearing, not style. `export VAR="$(cmd)"` returns export's
# own status, so a dev server that failed to start would sail past `set -e` and launch the host with
# an empty origin -- a bundled panel presenting as the live one. This actually happened.
assert_not_contains "$stable_release" \
    'export AGENTDESK_AGENT_PANEL_ORIGIN="$(just' \
    'the origin must not be exported straight from a command substitution'
assert_not_contains "$dev_debug" \
    'export AGENTDESK_AGENT_PANEL_ORIGIN="$(just' \
    'the origin must not be exported straight from a command substitution'
assert_contains "$stable_release" \
    'ERROR: agent-webview-dev-ensure printed more than an origin' \
    'a launch must check the captured origin instead of trusting stdout'

# The ensure recipe passes the origin by printing it, so anything else it runs must not print to
# stdout. The dependency check did, once, and the two-line result reached the host as an origin it
# could only refuse -- breaking the Mac panel and every attached phone at the same time.
ensure="$(just --dry-run agent-webview-dev-ensure 2>&1)"
assert_contains "$ensure" \
    'ensure-js-dependencies.mjs" agent-panel "$WEB" "$ROOT/.build/js-dependencies" >&2' \
    'the dependency check must not write to the stdout that carries the origin'

# The plain-browser leg. A browser has no relay to attach the sidecar's bearer header, so the dev
# server's own /api proxy attaches it -- which only works if the server and the sidecar share a
# token. The server starts first and outlives every launch, so it mints, and the host adopts.
#
# Asserted on the wiring because the failure is invisible from everywhere else: the Mac webview and
# the phone go through the relay, so they keep working while a browser tab silently shows nothing.
assert_contains "$ensure" \
    'AGENT_FEED_CONTROL_TOKEN="$TOKEN"' \
    'the dev server must carry the token its /api proxy attaches for a browser'
assert_contains "$ensure" \
    'umask 077' \
    'the token file must not be world-readable'
for launch in "$stable_release" "$dev_debug"; do
    assert_contains "$launch" \
        'node tools/build-system/install-runtime.mjs host "$BUILT_APP" "$APP" "$HOST_BID"' \
        'a launch must publish the signed build as an independent installed app'
    assert_contains "$launch" \
        'sh tools/exact-executable-pids.sh "$APP/Contents/MacOS/AgentDeskHost"' \
        'launch and stop must discover only the installed executable'
    assert_contains "$launch" \
        'just grid-encoder-install' \
        'a host deployment must install its standalone helper'
    assert_contains "$launch" \
        'export AGENT_FEED_CONTROL_TOKEN="$DEV_FEED_TOKEN"' \
        'a live panel launch must adopt the dev server token rather than let the host mint one'
done
stop="$(just --dry-run agent-webview-dev-stop 2>&1)"
assert_contains "$stop" \
    "$(node tools/runtime-paths.mjs panel-token)" \
    'stopping the dev server must take its token with it'
assert_contains "$ensure" \
    'ERROR: running dev server has no durable control token' \
    'a missing runtime token must stop launch without minting a mismatched token'
for variant in stable dev; do
    for recipe in client-diagnostics client-screenshot client-debug-bundle pair-iphone iphone-console-run pair-sim sim-console-run; do
        diagnostic="$(just --dry-run "$recipe" "$variant" 2>&1)"
        assert_contains "$diagnostic" \
            'sh tools/exact-executable-pids.sh "$HOST_APP/Contents/MacOS/AgentDeskHost"' \
            "$recipe $variant must discover the installed host executable"
    done
done
for recipe in dom-mirror-e2e motion-verify; do
    launch="$(env AGENTDESK_RUNTIME_ROOT='/private/agentdesk lifecycle runtime' \
        AGENT_FEED_GRID_ENCODER_PATH='/private/agentdesk lifecycle helper' \
        AGENTDESK_HOST_BUNDLE_ID='test.agentdesk.lifecycle' just --dry-run "$recipe" 2>&1)"
    assert_contains "$launch" \
        "PRODUCT_BUNDLE_IDENTIFIER='test.agentdesk.lifecycle'" \
        "$recipe must build the same bundle identity it installs"
    assert_contains "$launch" \
        "--env 'AGENTDESK_RUNTIME_ROOT=/private/agentdesk lifecycle runtime'" \
        "$recipe must pass the selected runtime root to the launched host"
    assert_contains "$launch" \
        "--env 'AGENT_FEED_GRID_ENCODER_PATH=/private/agentdesk lifecycle helper'" \
        "$recipe must pass the installed helper override to the launched host"
done
assert_contains "$(cat "$(dirname "$0")/launch-env.sh")" \
    'AGENT_FEED_CONTROL_TOKEN' \
    'the adopted token must reach a host launched by open, which inherits launchd, not the shell'
assert_contains "$dev_debug" \
    "if [ 'live' = live ]" \
    'Debug launch must serve the panel live by default'

bundled="$(just --dry-run host-run stable bundled 2>&1)"
assert_contains "$bundled" \
    "if [ 'bundled' = live ]" \
    'panel=bundled must leave the origin unset so the bundled webview is what loads'

# The phone gets the same live panel over the tailnet, but NOT from its launch environment
# (ADR-0096). The host states the origin over the agent lane on every attach, because the install
# that has to work is the TestFlight one, which has no environment at all -- and because restating
# it is what makes the phone survive a close and reopen with nothing remembered. So the assertion
# here is the negative: a launch that carries the origin as an env var is the old mechanism coming
# back, and it would work perfectly on a cabled dev client while silently doing nothing for the
# install that motivated this.
for launch in 'pair-iphone stable' 'iphone-console-run stable'; do
    # shellcheck disable=SC2086
    phone="$(just --dry-run $launch 2>&1)"
    assert_not_contains "$phone" \
        'AGENTDESK_AGENT_PANEL_ORIGIN' \
        "$launch must not deliver the panel origin through the launch environment"
    assert_contains "$phone" \
        'xcrun devicectl device process launch' \
        "$launch must still launch the client"
done

printf 'host run lifecycle tests passed\n'
