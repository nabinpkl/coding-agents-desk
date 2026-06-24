#!/usr/bin/env sh
set -eu

client_fixture="tests/fixtures/owned-media/hybrid-freeze-client.log"
host_fixture="tests/fixtures/owned-media/hybrid-freeze-host.log"

output="$(tools/hybrid-graphics-diagnostics-summary.sh "$client_fixture" "$host_fixture")"

assert_contains() {
    needle="$1"
    if ! printf '%s\n' "$output" | grep -F "$needle" >/dev/null; then
        printf 'missing expected summary text: %s\n' "$needle" >&2
        printf '%s\n' "$output" >&2
        exit 1
    fi
}

assert_contains "Hybrid graphics diagnostics summary"

# Client section: single damage-driven channel applied-frame metrics.
assert_contains "client graphics framesApplied=4 generations=2 failed=1 acks=4"
assert_contains "client graphics copyRectFrames=2 copyRectsTotal=3 maxTileBytes=2073600"
assert_contains "client graphics backlog maxQueuedFrames=4 maxQueueDepthBytes=1180000 maxStale=1"
assert_contains "client graphics timing maxCompositorMs=18.00 maxTileDecodeMs=9.10 maxTilePaintMs=3.00 maxMakeImageMs=2.20"

# Host section: send/accept/ack of the retained command stream.
assert_contains "host graphics framesSent=5 generations=2 resets=1 resetStripeAcks=1"
assert_contains "host graphics channel connected=2 disconnected=1 staleDisconnected=1 activeReplaced=1"
assert_contains "host graphics acceptedBy copyRect=2 damageTiles=2 fullframeTiles=1"
assert_contains "host graphics copyRect payloadBytes max=21000 avg=18000"
assert_contains "host graphics fullframeTiles payloadBytes max=913727 avg=913727"
assert_contains "host graphics backpressure holds=1 maxInFlight=2 maxUnacked=2"
assert_contains "host graphics acks=4 maxCompositorMs=32.11 maxQueuedFrames=2 maxQueueBytes=44000 maxStale=1"

printf 'hybrid graphics diagnostics summary tests passed\n'
