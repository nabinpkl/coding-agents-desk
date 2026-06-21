#!/usr/bin/env sh
set -eu

client_log="${1:-/tmp/agentdesk-client-console.log}"
host_log="${2:-}"

if [ -f "$client_log" ]; then
    client_source="$client_log"
else
    client_source="/dev/null"
fi

if [ -n "$host_log" ] && [ -f "$host_log" ]; then
    host_source="$host_log"
else
    host_source="/dev/null"
fi

echo "Hybrid graphics diagnostics summary"
echo "clientLog=$client_log"
if [ -n "$host_log" ]; then
    echo "hostLog=$host_log"
else
    echo "hostLog=(none)"
fi
echo

perl -ne '
    sub max_value {
        my ($name, $value) = @_;
        $max{$name} = $value if !defined($max{$name}) || $value > $max{$name};
    }

    $graphicsFrame++ if /graphics-frame /;
    $graphicsFrameFailed++ if /graphics-frame-failed /;
    $graphicsAck++ if /graphics-ack /;
    $graphicsResetRequest++ if /graphics-reset-request(?: |-|$)/;
    $graphicsResetDropped++ if /graphics-reset-request-dropped /;
    $graphicsResetFailed++ if /graphics-reset-request-failed /;
    $graphicsResetFallback++ if /graphics-reset-(?:request-)?fallback /;
    $graphicsReconnect++ if /owned graphics quic (ready|state=.*ready|state=.*preparing|state=.*setup)/;
    $graphicsDisconnect++ if /owned graphics quic (receive failed|connect failed|state=.*(failed|cancelled|waiting))/ ||
        /graphics-reset-request-(dropped|failed).*Socket is not connected/;
    $hevcComplete++ if /complete .*bytes=/;
    $hevcAck++ if /frame-ack /;
    $hevcRender++ if /render /;
    $drainHint++ if /action=(flush|reset|drop|failed)/;

    if (/copyRects=([0-9]+)/) {
        $copyRects += $1;
        max_value("copyRects", $1);
    }
    if (/tileBytes=([0-9]+)/) {
        $tileBytes += $1;
        max_value("tileBytes", $1);
    }
    if (/graphics-frame .*bytes=([0-9]+)/) {
        $graphicsBytes += $1;
        max_value("graphicsBytes", $1);
    }
    if (/complete .*bytes=([0-9]+)/) {
        $hevcBytes += $1;
        max_value("hevcBytes", $1);
    }
    if (/complete .*packets=([0-9]+)/) {
        $hevcPackets += $1;
        max_value("hevcPackets", $1);
        $hevcPacketFramesOver100++ if $1 >= 100;
    }
    if (/compositorMs=([0-9.]+)/) {
        $graphicsCompositorCount++;
        $graphicsCompositorTotal += $1;
        max_value("graphicsCompositorMs", $1);
    }
    if (/graphicsAckRttMs=([0-9.]+)/ || /graphics.*ackRttMs=([0-9.]+)/) {
        $graphicsAckRttCount++;
        max_value("graphicsAckRttMs", $1);
    }
    if (/(?:graphicsQueueDepth|queueDepth|queuedFrames)=([0-9]+)/) {
        $graphicsQueueSamples++;
        max_value("graphicsQueueFrames", $1);
    }
    if (/(?:graphicsQueueBytes|queueDepthBytes|queuedBytes)=([0-9]+)/) {
        $graphicsQueueByteSamples++;
        max_value("graphicsQueueBytes", $1);
    }
    if (/backlogFrames=([0-9]+)/) {
        $hevcBacklogSamples++;
        max_value("hevcBacklogFrames", $1);
    }
    if (/backlogBytes=([0-9]+)/) {
        max_value("hevcBacklogBytes", $1);
    }
    if (/renderGapMs=([0-9.]+)/) {
        max_value("renderGapMs", $1);
    }

    END {
        my $avgCompositor = $graphicsCompositorCount ? $graphicsCompositorTotal / $graphicsCompositorCount : 0;
        printf "client graphics frames=%d failed=%d acks=%d copyRects=%d maxCopyRects=%d tileBytes=%d maxTileBytes=%d payloadBytes=%d\n",
            $graphicsFrame||0, $graphicsFrameFailed||0, $graphicsAck||0, $copyRects||0, $max{"copyRects"}||0, $tileBytes||0, $max{"tileBytes"}||0, $graphicsBytes||0;
        printf "client graphics resetRequests=%d dropped=%d failed=%d fallback=%d reconnectHints=%d disconnectHints=%d\n",
            $graphicsResetRequest||0, $graphicsResetDropped||0, $graphicsResetFailed||0, $graphicsResetFallback||0, $graphicsReconnect||0, $graphicsDisconnect||0;
        printf "client graphics timing compositorSamples=%d avgCompositorMs=%.2f maxCompositorMs=%.2f ackRttSamples=%d maxAckRttMs=%.2f\n",
            $graphicsCompositorCount||0, $avgCompositor, $max{"graphicsCompositorMs"}||0, $graphicsAckRttCount||0, $max{"graphicsAckRttMs"}||0;
        printf "client graphics queue samples=%d maxFrames=%d byteSamples=%d maxBytes=%d\n",
            $graphicsQueueSamples||0, $max{"graphicsQueueFrames"}||0, $graphicsQueueByteSamples||0, $max{"graphicsQueueBytes"}||0;
        printf "client hevc complete=%d render=%d frameAck=%d bytes=%d maxBytes=%d packets=%d maxPackets=%d framesOver100Packets=%d\n",
            $hevcComplete||0, $hevcRender||0, $hevcAck||0, $hevcBytes||0, $max{"hevcBytes"}||0, $hevcPackets||0, $max{"hevcPackets"}||0, $hevcPacketFramesOver100||0;
        printf "client hevc backlogSamples=%d maxBacklogFrames=%d maxBacklogBytes=%d maxRenderGapMs=%.2f drainHints=%d\n",
            $hevcBacklogSamples||0, $max{"hevcBacklogFrames"}||0, $max{"hevcBacklogBytes"}||0, $max{"renderGapMs"}||0, $drainHint||0;
    }
' "$client_source"

echo

perl -ne '
    sub max_value {
        my ($name, $value) = @_;
        $max{$name} = $value if !defined($max{$name}) || $value > $max{$name};
    }

    $scrollAccepted++ if /owned graphics scroll-accepted/;
    $scrollAcceptedHint++ if /owned graphics scroll-accepted/ && /acceptedBy=hint/;
    $scrollAcceptedBlind++ if /owned graphics scroll-accepted/ && /acceptedBy=blind/;
    $scrollRejected++ if /owned graphics scroll-rejected/;
    $scrollTimeout++ if /owned graphics scroll-timeout/;
    $scrollHintTimeout++ if /owned graphics scroll-hint-timeout/;
    $scrollBlindTimeout++ if /owned graphics scroll-timeout/;
    if (/hintSource=([^[:space:]]+)/) {
        my $source = $1;
        if ($source eq "input") {
            $hintSourceInput++;
        } elsif ($source eq "ownership") {
            $hintSourceOwnership++;
        } elsif ($source eq "blind") {
            $hintSourceBlind++;
        } else {
            $hintSourceOther++;
        }
    }
    my $ownershipState = "";
    if (/ownership=(accepted|miss|released)(?:[[:space:]]|$)/) {
        $ownershipState = $1;
    } elsif (/scroll-ownership[- ](accepted|miss|released)(?:[[:space:]]|$)/) {
        $ownershipState = $1;
    }
    if ($ownershipState ne "") {
        my $state = $ownershipState;
        if ($state eq "accepted") {
            $ownershipAccepted++;
        } elsif ($state eq "miss") {
            $ownershipMiss++;
        } elsif ($state eq "released") {
            $ownershipReleased++;
        }
    }
    $graphicsResetFrame++ if /owned graphics reset frame=/;
    $graphicsResetStripe++ if /owned graphics reset[- ]stripe(?:[[:space:]]|$)/ || /resetStripe(?:[[:space:]]|=)/;
    $graphicsResetStripeAckTimeout++ if /reset[- ]stripe[- ]ack[- ]timeout/i || /resetStripeAckTimeout(?:[[:space:]]|=)/;
    $graphicsResetQueued++ if /owned graphics reset queued/;
    $graphicsResetConsumed++ if /owned graphics reset consumed/;
    $graphicsResetFallbackReceived++ if /owned graphics reset fallback received/;
    $graphicsResetAcked++ if /owned graphics reset acked/;
    $graphicsResetSendFailed++ if /owned graphics reset send failed/;
    $graphicsReconnect++ if /owned graphics quic (accepted|connection state=.*ready|listener state=.*ready|connection state=.*preparing|connection state=.*setup)/;
    $graphicsDisconnect++ if /owned graphics quic (connection state=.*(failed|cancelled|waiting)|hello receive failed|hello failed|listener failed)/ ||
        /owned graphics .*send failed.*Socket is not connected/;
    $hostFrame++ if /owned media host-frame frame=/;
    $hostAck++ if /owned media host-frame-ack/;
    $hevcFallback++ if /owned media hevc-fallback /;
    $hevcSuppressedByOwnership++ if /suppressed-by-ownership/ ||
        /owned media hevc-suppressed .*ownership/ ||
        /owned media admission-hold .*reason=ownership-suppressed/;
    $drainEnter++ if /owned media drain-enter/;
    $drainExit++ if /owned media drain-exit/;
    $admissionHold++ if /owned media admission-hold/;

    if (/owned graphics scroll-accepted .*commands=([0-9]+)/) {
        $graphicsCommands += $1;
        max_value("graphicsCommands", $1);
    }
    if (/owned graphics (?:scroll-accepted|reset) .*payloadBytes=([0-9]+)/) {
        $graphicsPayloadBytes += $1;
        max_value("graphicsPayloadBytes", $1);
    }
    my $resetStripeBytes = "";
    if (/owned graphics reset[- ]stripe .*bytes=([0-9]+)/) {
        $resetStripeBytes = $1;
    } elsif (/resetStripe .*bytes=([0-9]+)/) {
        $resetStripeBytes = $1;
    } elsif (/resetStripeBytes=([0-9]+)/) {
        $resetStripeBytes = $1;
    }
    if ($resetStripeBytes ne "") {
        max_value("resetStripeBytes", $resetStripeBytes);
    }
    if (/owned media host-frame .*bytes=([0-9]+)/) {
        $hevcBytes += $1;
        max_value("hevcBytes", $1);
    }
    if (/owned media host-frame .*packets=([0-9]+)/) {
        $hevcPackets += $1;
        max_value("hevcPackets", $1);
        $hevcPacketFramesOver100++ if $1 >= 100;
    }
    if (/ackRttMs=([0-9.]+)/) {
        $ackRttCount++;
        max_value("ackRttMs", $1);
    }
    if (/captureToAckMs=([0-9.]+)/) {
        max_value("captureToAckMs", $1);
    }
    if (/renderGapMs=([0-9.]+)/) {
        max_value("renderGapMs", $1);
    }
    if (/probeMs=([0-9.]+)/) {
        max_value("probeMs", $1);
    }
    if (/candidateCount=([0-9]+)/ || /candidates=([0-9]+)/) {
        max_value("candidateCount", $1);
    }
    if (/unacked=([0-9]+)/) {
        max_value("unackedFrames", $1);
    }
    if (/owned media host-frame-ack .*bytes=([0-9]+)/ || /owned media admission-state .*bytes=([0-9]+)/) {
        max_value("unackedBytes", $1);
    }
    if (/owned media admission-hold/ && /reason=([^[:space:]]+)/) {
        my $reason = $1;
        $holdReasons{$reason}++;
    }
    if (/owned media hevc-fallback/ && /reason=([^[:space:]]+)/) {
        my $reason = $1;
        $fallbackReasons{$reason}++;
    }

    END {
        printf "host scroll accepted=%d hintAccepted=%d blindAccepted=%d rejected=%d timeout=%d hintTimeout=%d blindTimeout=%d maxProbeMs=%.2f maxCandidates=%d\n",
            $scrollAccepted||0, $scrollAcceptedHint||0, $scrollAcceptedBlind||0, $scrollRejected||0,
            ($scrollTimeout||0) + ($scrollHintTimeout||0), $scrollHintTimeout||0, $scrollBlindTimeout||0,
            $max{"probeMs"}||0, $max{"candidateCount"}||0;
        printf "host scroll hintSources input=%d ownership=%d blind=%d other=%d\n",
            $hintSourceInput||0, $hintSourceOwnership||0, $hintSourceBlind||0, $hintSourceOther||0;
        printf "host scroll ownership accepted=%d miss=%d released=%d\n",
            $ownershipAccepted||0, $ownershipMiss||0, $ownershipReleased||0;
        printf "host graphics resets=%d queued=%d consumed=%d sendFailed=%d reconnectHints=%d disconnectHints=%d fallbackReceived=%d acked=%d commands=%d maxCommands=%d payloadBytes=%d maxPayloadBytes=%d resetStripes=%d resetStripeAckTimeout=%d maxResetStripeBytes=%d\n",
            $graphicsResetFrame||0, $graphicsResetQueued||0, $graphicsResetConsumed||0, $graphicsResetSendFailed||0,
            $graphicsReconnect||0, $graphicsDisconnect||0, $graphicsResetFallbackReceived||0, $graphicsResetAcked||0,
            $graphicsCommands||0, $max{"graphicsCommands"}||0, $graphicsPayloadBytes||0, $max{"graphicsPayloadBytes"}||0,
            $graphicsResetStripe||0, $graphicsResetStripeAckTimeout||0, $max{"resetStripeBytes"}||0;
        printf "host hevc frames=%d acks=%d bytes=%d maxBytes=%d packets=%d maxPackets=%d framesOver100Packets=%d\n",
            $hostFrame||0, $hostAck||0, $hevcBytes||0, $max{"hevcBytes"}||0, $hevcPackets||0, $max{"hevcPackets"}||0, $hevcPacketFramesOver100||0;
        printf "host hevc fallbacks=%d suppressedByOwnership=%d\n", $hevcFallback||0, $hevcSuppressedByOwnership||0;
        if (%fallbackReasons) {
            my @parts = map { "$_=$fallbackReasons{$_}" } sort keys %fallbackReasons;
            print "host hevcFallbackReasons " . join(" ", @parts) . "\n";
        } else {
            print "host hevcFallbackReasons none\n";
        }
        printf "host timing ackSamples=%d maxAckRttMs=%.2f maxCaptureToAckMs=%.2f maxRenderGapMs=%.2f\n",
            $ackRttCount||0, $max{"ackRttMs"}||0, $max{"captureToAckMs"}||0, $max{"renderGapMs"}||0;
        printf "host queue maxUnackedFrames=%d maxUnackedBytes=%d\n",
            $max{"unackedFrames"}||0, $max{"unackedBytes"}||0;
        printf "host drain enter=%d exit=%d admissionHolds=%d\n",
            $drainEnter||0, $drainExit||0, $admissionHold||0;
        if (%holdReasons) {
            my @parts = map { "$_=$holdReasons{$_}" } sort keys %holdReasons;
            print "host admissionHoldReasons " . join(" ", @parts) . "\n";
        } else {
            print "host admissionHoldReasons none\n";
        }
    }
' "$host_source"
