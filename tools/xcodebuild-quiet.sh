#!/bin/sh
# xcodebuild with a quiet successful path, a loud failing one, and a pulse in between.
#
# Every device and launch recipe wants a clean terminal while a build succeeds, so they all
# used to end in `>/dev/null`. But xcodebuild writes compiler diagnostics to stdout and only
# the "** BUILD FAILED **" summary to stderr, so that redirect discarded exactly the lines you
# need when it breaks. A failing Release host build reported the name of every file in the
# failing compile unit and no reason at all, which reads as "just fresh-install is broken" with
# nothing to act on.
#
# Silence has its own failure mode, found the same way: a Release device build takes minutes
# and printed nothing at all while it ran, so a slow build, a stalled one, and a build waiting
# on an unreachable iPhone were indistinguishable -- all three look like a hung terminal, and
# the honest reaction is to kill it, which is how a good run got killed at the codesign step.
# So the quiet path is no longer silent: it prints one heartbeat line every
# AGENTDESK_XCODEBUILD_PULSE_SECONDS with elapsed time and the phase xcodebuild is in. Enough
# to tell moving from stuck, few enough lines to still call it quiet.
#
# Set AGENTDESK_XCODEBUILD_VERBOSE=1 for the raw firehose instead, when the heartbeat is not
# enough and you want to watch the build itself.
set -eu

pulse_seconds="${AGENTDESK_XCODEBUILD_PULSE_SECONDS:-15}"
verbose="${AGENTDESK_XCODEBUILD_VERBOSE:-0}"

log="$(mktemp -t agentdesk-xcodebuild)"
reporter_pid=""

cleanup() {
    if [ -n "$reporter_pid" ]; then
        kill "$reporter_pid" 2>/dev/null || true
        wait "$reporter_pid" 2>/dev/null || true
    fi
    rm -f "$log"
}
trap cleanup EXIT

# Phase lines, not file lines. `CompileSwift` fires once per module rather than per file, so
# this names what is happening without turning the heartbeat back into the firehose it exists
# to avoid.
current_phase() {
    grep -E '^(SwiftDriver|SwiftCompile|CompileSwiftSources|CompileC|Ld|CodeSign|ProcessInfoPlistFile|GenerateDSYMFile|Copy|Validate|=== BUILD)' "$log" 2>/dev/null |
        tail -1 |
        sed -e 's#/[^ ]*/##g' |
        cut -c1-80
}

if [ "$verbose" = "1" ]; then
    tail -f "$log" 2>/dev/null &
    reporter_pid=$!
else
    # Heartbeat to stderr: recipes that pipe stdout keep their clean output, and a human
    # watching the terminal still sees the build breathing.
    start="$(date +%s)"
    (
        while :; do
            sleep "$pulse_seconds"
            phase="$(current_phase)"
            if [ -z "$phase" ]; then
                # No phase line yet -- planning, dependency scanning, or waiting on a
                # destination. Fall back to how much xcodebuild has written, because a growing
                # line count is the difference between "thinking" and "wedged", and that is the
                # exact distinction this heartbeat exists to draw.
                phase="planning ($(wc -l <"$log" | tr -d ' ') lines)"
            fi
            printf '  … xcodebuild %ss  %s\n' "$(( $(date +%s) - start ))" "$phase" >&2
        done
    ) &
    reporter_pid=$!
fi

status=0
xcodebuild "$@" >"$log" 2>&1 || status=$?

if [ "$status" -eq 0 ]; then
    exit 0
fi

echo "xcodebuild failed: $*" >&2
if grep -qE '\berror:' "$log"; then
    grep -E '\berror:' "$log" >&2
else
    # Nothing to isolate: signing, provisioning, a destination miss, or a compiler crash all
    # fail without an `error:` line. Show the tail rather than nothing.
    tail -60 "$log" >&2
fi
exit "$status"
