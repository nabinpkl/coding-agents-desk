#!/usr/bin/env sh
set -eu

tmpdir="$(mktemp -d)"
host_pid=""
sidecar_pid=""
manager_pid=""
other_host_pid=""

cleanup() {
    for pid in "$host_pid" "$sidecar_pid" "$manager_pid" "$other_host_pid"; do
        if [ -n "$pid" ]; then
            kill "$pid" 2>/dev/null || true
        fi
    done
    rm -rf "$tmpdir"
}
trap cleanup EXIT INT TERM

app="$tmpdir/checkout with spaces/AgentDeskHost.app"
other_app="$tmpdir/other-checkout/AgentDeskHost.app"
host_executable="$app/Contents/MacOS/AgentDeskHost"
sidecar_executable="$app/Contents/Resources/agent-feed-sidecar"
manager_executable="$app/Contents/Resources/pty-manager"
other_host_executable="$other_app/Contents/MacOS/AgentDeskHost"

mkdir -p "$(dirname "$host_executable")" "$(dirname "$sidecar_executable")" \
    "$(dirname "$other_host_executable")"
cp /bin/sleep "$host_executable"
cp /bin/sleep "$sidecar_executable"
cp /bin/sleep "$manager_executable"
cp /bin/sleep "$other_host_executable"

"$host_executable" 30 &
host_pid=$!
"$sidecar_executable" 30 &
sidecar_pid=$!
"$manager_executable" 30 &
manager_pid=$!
"$other_host_executable" 30 &
other_host_pid=$!

actual="$(sh tools/exact-executable-pids.sh "$host_executable")"
if [ "$actual" != "$host_pid" ]; then
    printf 'exact executable selector mismatch\nexpected: %s\nactual:   %s\n' \
        "$host_pid" "$actual" >&2
    exit 1
fi

printf 'exact executable pid tests passed\n'
