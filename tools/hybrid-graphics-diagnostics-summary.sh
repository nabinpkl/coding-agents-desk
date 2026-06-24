#!/usr/bin/env sh
set -eu

# Summarize the single-channel owned-graphics pipeline from a client console log
# and an optional host unified log. The host media path is one damage-driven
# graphics channel: every frame is a retained-mode command stream accepted by
# damage (copyRect scroll), damage-tiles (small update), or damage-fullframe-tiles
# (whole-surface resend). There is no encoder, datagram channel, scroll probe,
# viewport tracker, or admission layer to report on anymore.

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

    # graphics-frame is the applied-frame line. graphics-frame-apply-start and
    # graphics-frame-failed are excluded from the applied count.
    if (/\[owned-media\] graphics-frame frame=/) {
        $frames++;
        if (/generation=([0-9]+)/) { $gens{$1}++; }
        if (/copyRects=([0-9]+)/) {
            $copyRectsTotal += $1;
            $copyRectFrames++ if $1 > 0;
        }
        if (/tileBytes=([0-9]+)/) { max_value("tileBytes", $1); }
        if (/queuedFrames=([0-9]+)/) { max_value("queuedFrames", $1); }
        if (/queueDepthBytes=([0-9]+)/) { max_value("queueDepthBytes", $1); }
        if (/stale=([0-9]+)/) { max_value("stale", $1); }
        if (/compositorMs=([0-9.]+)/) { max_value("compositorMs", $1); }
        if (/tileDecodeMs=([0-9.]+)/) { max_value("tileDecodeMs", $1); }
        if (/tilePaintMs=([0-9.]+)/) { max_value("tilePaintMs", $1); }
        if (/makeImageMs=([0-9.]+)/) { max_value("makeImageMs", $1); }
    }
    $failed++ if /\[owned-media\] graphics-frame-failed /;
    if (/\[owned-media\] graphics-ack /) {
        $acks++;
        if (/queuedFrames=([0-9]+)/) { max_value("queuedFrames", $1); }
        if (/queueDepthBytes=([0-9]+)/) { max_value("queueDepthBytes", $1); }
        if (/stale=([0-9]+)/) { max_value("stale", $1); }
        if (/compositorMs=([0-9.]+)/) { max_value("compositorMs", $1); }
    }

    END {
        printf "client graphics framesApplied=%d generations=%d failed=%d acks=%d\n",
            $frames||0, scalar(keys %gens), $failed||0, $acks||0;
        printf "client graphics copyRectFrames=%d copyRectsTotal=%d maxTileBytes=%d\n",
            $copyRectFrames||0, $copyRectsTotal||0, $max{"tileBytes"}||0;
        printf "client graphics backlog maxQueuedFrames=%d maxQueueDepthBytes=%d maxStale=%d\n",
            $max{"queuedFrames"}||0, $max{"queueDepthBytes"}||0, $max{"stale"}||0;
        printf "client graphics timing maxCompositorMs=%.2f maxTileDecodeMs=%.2f maxTilePaintMs=%.2f maxMakeImageMs=%.2f\n",
            $max{"compositorMs"}||0, $max{"tileDecodeMs"}||0, $max{"tilePaintMs"}||0, $max{"makeImageMs"}||0;
    }
' "$client_source"

echo

perl -ne '
    sub max_value {
        my ($name, $value) = @_;
        $max{$name} = $value if !defined($max{$name}) || $value > $max{$name};
    }

    if (/owned graphics sent frame=/) {
        $sent++;
        if (/generation=([0-9]+)/) { $gens{$1}++; }
    }
    if (/owned graphics in-flight-sent /) {
        if (/inFlight=([0-9]+)/) { max_value("inFlight", $1); }
        if (/maxUnacked=([0-9]+)/) { max_value("maxUnacked", $1); }
    }
    if (/owned graphics accepted /) {
        if (/acceptedBy=([a-z-]+)/) {
            my $kind = $1;
            my $bytes = 0;
            $bytes = $1 if /payloadBytes=([0-9]+)/;
            if ($kind eq "damage") {
                $copyRect++;
                $copyRectBytesTotal += $bytes;
                max_value("copyRectBytes", $bytes);
            } elsif ($kind eq "damage-tiles") {
                $damageTiles++;
            } elsif ($kind eq "damage-fullframe-tiles" || $kind eq "damage-fullframe-jpeg") {
                # damage-fullframe-jpeg is the lossy single-JPEG fullframe fallback;
                # damage-fullframe-tiles is the older raw-LZFSE form. Both are the
                # whole-screen fallback whose payload size is the link-saturation
                # signal, so they share one counter.
                $fullframeTiles++;
                $fullframeBytesTotal += $bytes;
                max_value("fullframeBytes", $bytes);
            }
        }
    }
    $backpressureHolds++ if /owned graphics backpressure-hold /;
    if (/owned graphics ack frame=/) {
        $acks++;
        if (/compositorMs=([0-9.]+)/) { max_value("compositorMs", $1); }
        if (/queuedFrames=([0-9]+)/) { max_value("queuedFrames", $1); }
        if (/queueBytes=([0-9]+)/) { max_value("queueBytes", $1); }
        if (/stale=([0-9]+)/) { max_value("stale", $1); }
    }
    $resets++ if /owned graphics reset /;
    $resetStripeAcks++ if /owned graphics reset-stripe-ack/;
    $channelConnected++ if /owned graphics channel-connected/;
    $channelDisconnected++ if /owned graphics channel-disconnected/;
    $staleChannelDisconnected++ if /owned graphics stale-channel-disconnected/;
    $activeChannelReplaced++ if /owned graphics active-channel-replaced/;

    END {
        my $copyRectAvg = $copyRect ? $copyRectBytesTotal / $copyRect : 0;
        my $fullframeAvg = $fullframeTiles ? $fullframeBytesTotal / $fullframeTiles : 0;
        printf "host graphics framesSent=%d generations=%d resets=%d resetStripeAcks=%d\n",
            $sent||0, scalar(keys %gens), $resets||0, $resetStripeAcks||0;
        printf "host graphics channel connected=%d disconnected=%d staleDisconnected=%d activeReplaced=%d\n",
            $channelConnected||0, $channelDisconnected||0, $staleChannelDisconnected||0, $activeChannelReplaced||0;
        printf "host graphics acceptedBy copyRect=%d damageTiles=%d fullframeTiles=%d\n",
            $copyRect||0, $damageTiles||0, $fullframeTiles||0;
        printf "host graphics copyRect payloadBytes max=%d avg=%.0f\n",
            $max{"copyRectBytes"}||0, $copyRectAvg;
        printf "host graphics fullframeTiles payloadBytes max=%d avg=%.0f\n",
            $max{"fullframeBytes"}||0, $fullframeAvg;
        printf "host graphics backpressure holds=%d maxInFlight=%d maxUnacked=%d\n",
            $backpressureHolds||0, $max{"inFlight"}||0, $max{"maxUnacked"}||0;
        printf "host graphics acks=%d maxCompositorMs=%.2f maxQueuedFrames=%d maxQueueBytes=%d maxStale=%d\n",
            $acks||0, $max{"compositorMs"}||0, $max{"queuedFrames"}||0, $max{"queueBytes"}||0, $max{"stale"}||0;
    }
' "$host_source"
