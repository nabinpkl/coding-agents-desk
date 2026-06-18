#!/usr/bin/env sh
set -eu

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

cat > "$tmpdir/launchctl" <<'SH'
#!/usr/bin/env sh
printf '%s\n' "$*" >> "$LAUNCHCTL_LOG"
SH
chmod +x "$tmpdir/launchctl"

PATH="$tmpdir:$PATH"
export PATH
export LAUNCHCTL_LOG="$tmpdir/launchctl.log"

export AGENTDESK_CODEC=h264
export AGENTDESK_MEDIA_STACK=owned
export AGENTDESK_OWNED_MEDIA_CODEC=hevc
export AGENTDESK_OWNED_MEDIA_CHROMA=444
export AGENTDESK_OWNED_MEDIA_HEVC_PROFILE=main444
export AGENTDESK_OWNED_MEDIA_MAX_QP=24
export AGENTDESK_OWNED_MEDIA_DETAIL_ACTIVE=1
export AGENTDESK_OWNED_MEDIA_MOTION_ACTIVE=1
export AGENTDESK_TUNING_SCROLL_MAX_BITRATE_KBPS=7000
export AGENTDESK_TUNING_SCROLL_MIN_BITRATE_KBPS=2000
export AGENTDESK_TUNING_BWE_MAX_KBPS=10000
export AGENTDESK_UNRELATED=ignored

tools/launch-env.sh set
tools/launch-env.sh unset

grep -F 'setenv AGENTDESK_CODEC h264' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'setenv AGENTDESK_MEDIA_STACK owned' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'setenv AGENTDESK_OWNED_MEDIA_CODEC hevc' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'setenv AGENTDESK_OWNED_MEDIA_CHROMA 444' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'setenv AGENTDESK_OWNED_MEDIA_HEVC_PROFILE main444' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'setenv AGENTDESK_OWNED_MEDIA_MAX_QP 24' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'setenv AGENTDESK_OWNED_MEDIA_DETAIL_ACTIVE 1' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'setenv AGENTDESK_OWNED_MEDIA_MOTION_ACTIVE 1' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'setenv AGENTDESK_TUNING_SCROLL_MAX_BITRATE_KBPS 7000' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'setenv AGENTDESK_TUNING_SCROLL_MIN_BITRATE_KBPS 2000' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'setenv AGENTDESK_TUNING_BWE_MAX_KBPS 10000' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'unsetenv AGENTDESK_CODEC' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'unsetenv AGENTDESK_MEDIA_STACK' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'unsetenv AGENTDESK_OWNED_MEDIA_CODEC' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'unsetenv AGENTDESK_OWNED_MEDIA_CHROMA' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'unsetenv AGENTDESK_OWNED_MEDIA_HEVC_PROFILE' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'unsetenv AGENTDESK_OWNED_MEDIA_MAX_QP' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'unsetenv AGENTDESK_OWNED_MEDIA_DETAIL_ACTIVE' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'unsetenv AGENTDESK_OWNED_MEDIA_MOTION_ACTIVE' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'unsetenv AGENTDESK_TUNING_SCROLL_MAX_BITRATE_KBPS' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'unsetenv AGENTDESK_TUNING_SCROLL_MIN_BITRATE_KBPS' "$LAUNCHCTL_LOG" >/dev/null
grep -F 'unsetenv AGENTDESK_TUNING_BWE_MAX_KBPS' "$LAUNCHCTL_LOG" >/dev/null

if grep -F 'AGENTDESK_UNRELATED' "$LAUNCHCTL_LOG" >/dev/null; then
    echo "unrelated AGENTDESK var was forwarded" >&2
    exit 1
fi
