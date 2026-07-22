#!/bin/zsh
set -euo pipefail

SPIKE_ROOT="${0:A:h}"
REPO_ROOT="${SPIKE_ROOT:h:h}"
SPIKE_TEMP="$(mktemp -d /tmp/agentdesk-xterm-wkwebview.XXXXXX)"
SOCKET_PATH="$SPIKE_TEMP/pty-manager.sock"
MANAGER_LOG="$SPIKE_TEMP/pty-manager.log"
MANAGER_PID=""

cleanup() {
    if [[ -n "$MANAGER_PID" ]] && kill -0 "$MANAGER_PID" 2>/dev/null; then
        kill "$MANAGER_PID" 2>/dev/null || true
        wait "$MANAGER_PID" 2>/dev/null || true
    fi
    rm -rf "$SPIKE_TEMP"
}
trap cleanup EXIT INT TERM

npm ci --prefix "$SPIKE_ROOT"
npm run build --prefix "$SPIKE_ROOT"
cargo build --manifest-path "$REPO_ROOT/terminal/pty-manager/Cargo.toml" --bin pty-manager

MANAGER="$REPO_ROOT/terminal/pty-manager/target/debug/pty-manager"
RUST_LOG=info "$MANAGER" --socket "$SOCKET_PATH" >"$MANAGER_LOG" 2>&1 &
MANAGER_PID=$!

for _ in {1..100}; do
    [[ -S "$SOCKET_PATH" ]] && break
    sleep 0.05
done

if [[ ! -S "$SOCKET_PATH" ]]; then
    print -u2 "xterm spike: test-owned PTY manager did not create its socket"
    sed -n '1,160p' "$MANAGER_LOG" >&2
    exit 1
fi

swift run \
    --package-path "$SPIKE_ROOT" \
    XtermWKWebViewSpike \
    --socket "$SOCKET_PATH" \
    --cwd "$REPO_ROOT" \
    --self-test
