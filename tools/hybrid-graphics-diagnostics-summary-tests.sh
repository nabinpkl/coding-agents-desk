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
assert_contains "client graphics frames=1 failed=0 acks=1 copyRects=1"
assert_contains "client graphics resetRequests=2 dropped=1 failed=1"
assert_contains "client graphics timing compositorSamples=2"
assert_contains "client hevc complete=2 render=1 frameAck=2 bytes=800000 maxBytes=420000 packets=257 maxPackets=136 framesOver100Packets=2"
assert_contains "client hevc backlogSamples=3 maxBacklogFrames=4 maxBacklogBytes=1220000 maxRenderGapMs=186.00"
assert_contains "host scroll accepted=1 hintAccepted=1 blindAccepted=0 rejected=1 timeout=4 hintTimeout=1 blindTimeout=3 maxProbeMs=4.20 maxCandidates=11"
assert_contains "host scroll hintSources input=1 ownership=1 blind=1 other=0"
assert_contains "host scroll ownership accepted=1 miss=1 released=1"
assert_contains "host graphics resets=1 queued=1 consumed=0 sendFailed=0 reconnectHints=1 disconnectHints=1 fallbackReceived=0 acked=0 commands=2 maxCommands=2 payloadBytes=8318400 maxPayloadBytes=8294400 resetStripes=2 resetStripeAckTimeout=1 maxResetStripeBytes=524288"
assert_contains "host hevc frames=2 acks=2 bytes=800000 maxBytes=420000 packets=257 maxPackets=136 framesOver100Packets=2"
assert_contains "host hevc fallbacks=2 suppressedByOwnership=1"
assert_contains "host hevcFallbackReasons graphics-disconnected=1 scroll-timeout=1"
assert_contains "host timing ackSamples=2 maxAckRttMs=220.00 maxCaptureToAckMs=281.00 maxRenderGapMs=186.00"
assert_contains "host queue maxUnackedFrames=2 maxUnackedBytes=800000"
assert_contains "host drain enter=1 exit=1 admissionHolds=2"
assert_contains "host admissionHoldReasons drain-unacked=1 keyframe-inflight=1"

printf 'hybrid graphics diagnostics summary tests passed\n'
