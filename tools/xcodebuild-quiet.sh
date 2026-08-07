#!/bin/sh
# xcodebuild with a quiet successful path and a loud failing one.
#
# Every device and launch recipe wants a clean terminal while a build succeeds, so they all
# used to end in `>/dev/null`. But xcodebuild writes compiler diagnostics to stdout and only
# the "** BUILD FAILED **" summary to stderr, so that redirect discarded exactly the lines you
# need when it breaks. A failing Release host build reported the name of every file in the
# failing compile unit and no reason at all, which reads as "just fresh-install is broken" with
# nothing to act on.
#
# Same quiet success, but a failure prints why.
set -eu

log="$(mktemp -t agentdesk-xcodebuild)"
trap 'rm -f "$log"' EXIT

if xcodebuild "$@" >"$log" 2>&1; then
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
exit 1
