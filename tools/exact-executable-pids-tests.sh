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

# Build the placeholder process rather than copying /bin/sleep. Apple's system
# binaries carry a launch constraint binding them to their own path on the
# sealed system volume, so a copy is SIGKILLed by AMFI before main ("Launch
# Constraint Violation") and the selector then has no process to find.
cat > "$tmpdir/placeholder.c" <<'PLACEHOLDER'
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    sleep(argc > 1 ? (unsigned int)atoi(argv[1]) : 30u);
    return 0;
}
PLACEHOLDER
cc -o "$tmpdir/placeholder" "$tmpdir/placeholder.c"
cp "$tmpdir/placeholder" "$host_executable"
cp "$tmpdir/placeholder" "$sidecar_executable"
cp "$tmpdir/placeholder" "$manager_executable"
cp "$tmpdir/placeholder" "$other_host_executable"

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
