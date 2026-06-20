#!/bin/sh
set -eu

client_log="${1:-/tmp/agentdesk-client-console.log}"
host_window="${AGENTDESK_DIAG_HOST_LOG_WINDOW:-10m}"
host_log="$(mktemp -t agentdesk-host-owned-media.XXXXXX)"
trap 'rm -f "$host_log"' EXIT

if [ -f "$client_log" ]; then
    client_source="$client_log"
else
    client_source="/dev/null"
fi

/usr/bin/log show --last "$host_window" --style compact --info --debug \
    --predicate 'subsystem == "com.example.agentdesk.AgentDeskHost" && eventMessage CONTAINS "owned media"' \
    > "$host_log" 2>/dev/null || true

echo "Owned media diagnostics summary"
echo "clientLog=$client_log"
echo "hostWindow=$host_window"
echo

perl -ne '
    $timeline++ if /timeline /;
    $ack++ if /frame-ack /;
    $render++ if /render /;
    $complete++ if /complete /;
    $resend++ if /resend-request /;
    $expired++ if /expired-keyframe /;
    $stale++ if /skip-(stale|late)-/;
    $malformed++ if /drop-malformed /;
    $estimated++ if /displayPresentation=estimated/;
    if (/firstToCompleteMs=([0-9.]+)/) { $maxFirst = $1 if $1 > $maxFirst; $firstOver100++ if $1 >= 100; $firstOver300++ if $1 >= 300; }
    if (/renderGapMs=([0-9.]+)/) { $maxGap = $1 if $1 > $maxGap; $gapOver80++ if $1 >= 80; $gapOver200++ if $1 >= 200; }
    if (/completedQueueFrames=([0-9]+)/) { $maxQueueFrames = $1 if $1 > $maxQueueFrames; }
    if (/completedQueueBytes=([0-9]+)/) { $maxQueueBytes = $1 if $1 > $maxQueueBytes; }
    END {
        printf "client timeline=%d frameAck=%d render=%d complete=%d displayEstimated=%d\n", $timeline||0, $ack||0, $render||0, $complete||0, $estimated||0;
        printf "client repair resendRequests=%d expiredKeyframes=%d staleSkips=%d malformedOrAuthDrops=%d\n", $resend||0, $expired||0, $stale||0, $malformed||0;
        printf "client timing maxFirstToCompleteMs=%.1f over100=%d over300=%d maxRenderGapMs=%.1f over80=%d over200=%d\n", $maxFirst||0, $firstOver100||0, $firstOver300||0, $maxGap||0, $gapOver80||0, $gapOver200||0;
        printf "client completedQueue maxFrames=%d maxBytes=%d\n", $maxQueueFrames||0, $maxQueueBytes||0;
    }
' "$client_source"

echo

perl -ne '
    $fps++ if /owned media diag-fps/;
    $hostFrame++ if /owned media host-frame frame=/;
    $hostAck++ if /owned media host-frame-ack/;
    $drainEnter++ if /owned media drain-enter/;
    $drainExit++ if /owned media drain-exit/;
    $keyframe++ if /owned media keyframe-result|owned encoder keyframe-result/;
    $initial++ if /actualReason=initial|keyframeReason=initial/;
    $periodic++ if /actualReason=periodic|keyframeReason=periodic/;
    $clientRequest++ if /actualReason=client-request|keyframeReason=client-request/;
    $postDrain++ if /actualReason=post-drain-recovery|keyframeReason=post-drain-recovery/;
    $hold++ if /owned media admission-hold/;
    if (/sendMs=([0-9.]+)/) { $maxSend = $1 if $1 > $maxSend; }
    if (/ackRttMs=([0-9.]+)/) { $maxAckRtt = $1 if $1 > $maxAckRtt; }
    if (/captureToAckMs=([0-9.]+)/) { $maxCaptureAck = $1 if $1 > $maxCaptureAck; }
    if (/pacingReason=([a-z-]+)/) {
        $reason = $1;
        $normalPacing++ if $reason eq "normal";
        $largePacing++ if $reason eq "large-frame";
        $jumboPacing++ if $reason eq "jumbo-frame";
        $backpressurePacing++ if $reason eq "backpressure";
        if (/sendMs=([0-9.]+)/) {
            $maxSendByReason{$reason} = $1 if $1 > ($maxSendByReason{$reason} || 0);
        }
    }
    $latestFps = $_ if /owned media diag-fps/;
    END {
        chomp($latestFps);
        printf "host fpsLines=%d hostFrames=%d hostAcks=%d admissionHolds=%d\n", $fps||0, $hostFrame||0, $hostAck||0, $hold||0;
        printf "host drain enter=%d exit=%d\n", $drainEnter||0, $drainExit||0;
        printf "host keyframes total=%d initial=%d periodic=%d clientRequest=%d postDrainRecovery=%d\n", $keyframe||0, $initial||0, $periodic||0, $clientRequest||0, $postDrain||0;
        printf "host timing maxSendMs=%.1f maxAckRttMs=%.1f maxCaptureToAckMs=%.1f\n", $maxSend||0, $maxAckRtt||0, $maxCaptureAck||0;
        printf "host pacing normal=%d large=%d jumbo=%d backpressure=%d\n", $normalPacing||0, $largePacing||0, $jumboPacing||0, $backpressurePacing||0;
        printf "host pacingMaxSend normal=%.1f large=%.1f jumbo=%.1f backpressure=%.1f\n",
            $maxSendByReason{"normal"}||0,
            $maxSendByReason{"large-frame"}||0,
            $maxSendByReason{"jumbo-frame"}||0,
            $maxSendByReason{"backpressure"}||0;
        print "host latestFps=$latestFps\n" if $latestFps;
    }
' "$host_log"
