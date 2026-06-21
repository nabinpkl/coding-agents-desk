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
assert_contains "client graphics frames=1 failed=0 acks=1 copyRects=0 maxCopyRects=0"
assert_contains "client graphics resetRequests=2 dropped=0 failed=1 fallback=1"
assert_contains "client graphics channel connected=0 disconnected=0 capabilityRefreshRequests=1"
assert_contains "client graphics timing compositorSamples=2"
assert_contains "client graphics queue samples=2 maxFrames=1 byteSamples=2 maxBytes=262144"
assert_contains "client hevc complete=3 render=1 frameAck=3 bytes=1550000 maxBytes=610000 packets=484 maxPackets=190 framesOver100Packets=3"
assert_contains "client hevc backlogSamples=4 maxBacklogFrames=6 maxBacklogBytes=1970000 maxRenderGapMs=214.00"
assert_contains "host scroll accepted=0 hintAccepted=0 blindAccepted=0 rejected=1 timeout=2 hintTimeout=1 blindTimeout=1 maxProbeMs=4.40 maxCandidates=11"
assert_contains "host scroll hintSources input=0 ownership=3 blind=0 other=0"
assert_contains "host scroll ownership accepted=0 miss=3 released=0"
assert_contains "host graphics resets=0 queued=1 consumed=0 sendFailed=0 reconnectHints=1 disconnectHints=1 fallbackReceived=0 acked=1 commands=0 maxCommands=0 payloadBytes=0 maxPayloadBytes=0 resetStripes=2 resetStripeAckTimeout=1 maxResetStripeBytes=524288"
assert_contains "host graphics channel connected=1 disconnected=1 activeReplacements=1 resetAckWaitSuccess=1 resetAckWaitTimeout=1"
assert_contains "host graphicsRecoveryStates failedCoolingDown=1 reconnecting=1"
assert_contains "host hevc frames=3 acks=3 bytes=1550000 maxBytes=610000 packets=484 maxPackets=190 framesOver100Packets=3"
assert_contains "host hevc fallbacks=3 suppressedByOwnership=0 fallbackSuppressed=2"
assert_contains "host hevcFallbackReasons graphics-disconnected=1 graphics-reset-send-failed=1 scroll-timeout=1"
assert_contains "host hevcSuppressionReasons graphics-recovery-rate-limited=1 graphics-recovery-resetting=1"
assert_contains "host timing ackSamples=3 maxAckRttMs=260.00 maxCaptureToAckMs=330.00 maxRenderGapMs=214.00"
assert_contains "host queue maxUnackedFrames=3 maxUnackedBytes=1550000"
assert_contains "host drain enter=0 exit=1 admissionHolds=1"
assert_contains "host admissionHoldReasons keyframe-inflight=1"

printf 'hybrid graphics diagnostics summary tests passed\n'
