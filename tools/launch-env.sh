#!/usr/bin/env sh
set -eu

fixed_names='
AGENTDESK_AUTO_APPROVE
AGENTDESK_DEV_PERMISSIVE_KEYSTORE
AGENTDESK_CODEC
AGENTDESK_MEDIA_STACK
AGENTDESK_OWNED_MEDIA_CODEC
AGENTDESK_OWNED_MEDIA_CHROMA
AGENTDESK_OWNED_MEDIA_HEVC_PROFILE
AGENTDESK_OWNED_MEDIA_MAX_QP
AGENTDESK_OWNED_MEDIA_DATAGRAM_BURST_PACKET_COUNT
AGENTDESK_OWNED_MEDIA_DATAGRAM_BURST_PAUSE_US
AGENTDESK_OWNED_MEDIA_QUIC_MAX_DATAGRAM_BYTES
AGENTDESK_OWNED_MEDIA_CAPTURE_SCALE_DOWN
AGENTDESK_OWNED_MEDIA_BITRATE_KBPS
AGENTDESK_OWNED_MEDIA_FPS
AGENTDESK_OWNED_MEDIA_KEYFRAME_INTERVAL_FRAMES
AGENTDESK_TRANSCRIBE_URL
AGENTDESK_TRANSCRIBE_MODEL
AGENTDESK_SPACE_AGENT_LAYOUT
AGENTDESK_GESTURE_CHILD_PATH
AGENTDESK_GESTURE_CHILD_ARGS
AGENTDESK_VOICE_CHILD_PATH
AGENTDESK_VOICE_CHILD_ARGS
'

usage() {
    echo "usage: tools/launch-env.sh set|unset" >&2
    exit 64
}

action="${1:-}"
case "$action" in
    set|unset) ;;
    *) usage ;;
esac

set_if_present() {
    name="$1"
    value="$(printenv "$name" 2>/dev/null || true)"
    [ -n "$value" ] || return 0
    launchctl setenv "$name" "$value"
}

unset_if_present() {
    name="$1"
    value="$(printenv "$name" 2>/dev/null || true)"
    [ -n "$value" ] || return 0
    launchctl unsetenv "$name"
}

apply_name() {
    case "$action" in
        set) set_if_present "$1" ;;
        unset) unset_if_present "$1" ;;
    esac
}

for name in $fixed_names; do
    apply_name "$name"
done

env | while IFS='=' read -r name _; do
    case "$name" in
        AGENTDESK_TUNING_*) apply_name "$name" ;;
    esac
done
