#!/usr/bin/env bash
# Cross-version PTY runtime gate.
#
# Every other handover test builds both peers from one source tree, which is structurally
# incapable of testing a handover: a handover is a conversation between two DIFFERENT builds, and
# a same-version test always agrees with itself. That blind spot is how a field removal shipped
# green and stranded a four-day-old runtime that no current host could talk to.
#
# This gate runs the real thing: a runtime built from an older commit, holding a live session,
# then the current binaries taking over. The assertion is the invariant from ADR-0080, that a
# session survives any code update, including one that changes the wire.
#
# Usage: pty-handover-cross-version.sh <repo-root> [base-ref]
set -euo pipefail

ROOT="${1:?repo root required}"
BASE_REF="${2:-HEAD~1}"
SESSION="crossver"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/agentdesk-crossver.XXXXXX")"
# Unix socket paths are capped at SUN_LEN (104 bytes on Darwin) and `$TMPDIR` alone is most of that
# budget, so the sockets live in a deliberately short directory while the builds stay in $WORK.
RUN="$(mktemp -d /tmp/agdxv.XXXXXX)"
DAEMONS=()

cleanup() {
    for pid in "${DAEMONS[@]:-}"; do
        [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    done
    # The session's own child must not outlive the gate.
    pkill -f "$RUN" 2>/dev/null || true
    rm -rf "$WORK" "$RUN"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    for log in old-vault old-manager old-client new-vault new-manager cold-manager; do
        if [ -s "$RUN/$log.log" ]; then
            echo "--- $log ---" >&2
            tail -20 "$RUN/$log.log" >&2
        fi
    done
    exit 1
}

BASE_SHA="$(git -C "$ROOT" rev-parse --short "$BASE_REF")"
echo "cross-version handover: $BASE_SHA -> $(git -C "$ROOT" rev-parse --short HEAD)"

# Materialize the base tree with git archive rather than a worktree, so this never touches the
# checkout the caller is working in.
mkdir -p "$WORK/base"
# The crate has a vendored path dependency, so the base tree needs it at the same relative path.
git -C "$ROOT" archive "$BASE_REF" terminal/pty-manager terminal/vendor/alacritty_terminal \
    | tar -x -C "$WORK/base"

echo "building base runtime ($BASE_SHA)"
cargo build --quiet --manifest-path "$WORK/base/terminal/pty-manager/Cargo.toml" --bins
echo "building current runtime"
cargo build --quiet --manifest-path "$ROOT/terminal/pty-manager/Cargo.toml" --bins

OLD="$WORK/base/terminal/pty-manager/target/debug"
NEW="$ROOT/terminal/pty-manager/target/debug"
for binary in pty-vault pty-manager pty-client pty-status; do
    [ -x "$OLD/$binary" ] || fail "base build did not produce $binary"
    [ -x "$NEW/$binary" ] || fail "current build did not produce $binary"
done
VAULT_SOCK="$RUN/pty-vault.sock"
MANAGER_SOCK="$RUN/pty-manager.sock"

wait_for_sessions() {
    local status_bin="$1" expected="$2" label="$3" attempt
    for attempt in $(seq 1 100); do
        if "$status_bin" --socket "$MANAGER_SOCK" --sessions-only 2>/dev/null | grep -qx "$expected"; then
            return 0
        fi
        sleep 0.1
    done
    fail "$label: session '$expected' was not listed"
}

session_pid() {
    "$1" --socket "$MANAGER_SOCK" 2>/dev/null \
        | awk -v name="$SESSION" '$1 == name { for (i = 1; i <= NF; i++) if ($i ~ /^pid=/) { sub(/^pid=/, "", $i); print $i } }'
}

# 1. The previous generation, holding a real session.
"$OLD/pty-vault" --socket "$VAULT_SOCK" >"$RUN/old-vault.log" 2>&1 &
DAEMONS+=($!)
sleep 1
"$OLD/pty-manager" --socket "$MANAGER_SOCK" >"$RUN/old-manager.log" 2>&1 &
DAEMONS+=($!)
sleep 1

"$OLD/pty-client" --socket "$MANAGER_SOCK" --session "$SESSION" --shell /bin/sh \
    --cols 80 --rows 24 --no-footer </dev/null >"$RUN/old-client.log" 2>&1 &
CLIENT_PID=$!
sleep 2
kill "$CLIENT_PID" 2>/dev/null || true

wait_for_sessions "$OLD/pty-status" "$SESSION" "before handover"
PID_BEFORE="$(session_pid "$OLD/pty-status")"
[ -n "$PID_BEFORE" ] || fail "could not read the session pid before handover"
echo "base runtime holds '$SESSION' pid=$PID_BEFORE"

# 2. The current binaries take over, vault first, exactly as the host sequences it.
#
# Both assertions matter and they are different. A candidate that cannot hand over exits and leaves
# the older generation serving, which by ADR-0080 keeps the sessions alive. So "the session
# survived" alone would pass even when every handover failed and the machine is permanently stuck on
# an old binary, which is the outage this gate exists to catch. Assert first that the new binaries
# are the ones serving, then that the session came across.
"$NEW/pty-vault" --socket "$VAULT_SOCK" --handover >"$RUN/new-vault.log" 2>&1 &
NEW_VAULT_PID=$!
DAEMONS+=($NEW_VAULT_PID)
sleep 3
kill -0 "$NEW_VAULT_PID" 2>/dev/null \
    || fail "the current pty-vault could not take over from $BASE_SHA; it exited instead of handing over"
echo "current pty-vault took over"

"$NEW/pty-manager" --socket "$MANAGER_SOCK" --handover >"$RUN/new-manager.log" 2>&1 &
NEW_MANAGER_PID=$!
DAEMONS+=($NEW_MANAGER_PID)
sleep 3
kill -0 "$NEW_MANAGER_PID" 2>/dev/null \
    || fail "the current pty-manager could not take over from $BASE_SHA; it exited instead of handing over"
echo "current pty-manager took over"

wait_for_sessions "$NEW/pty-status" "$SESSION" "after handover"
PID_AFTER="$(session_pid "$NEW/pty-status")"
[ "$PID_AFTER" = "$PID_BEFORE" ] \
    || fail "handover replaced the child process (pid $PID_BEFORE -> ${PID_AFTER:-none})"
kill -0 "$PID_BEFORE" 2>/dev/null || fail "the session's child process is gone after handover"
echo "PASS: session survived the cross-version handover with pid=$PID_AFTER"

# 3. The fallback path: a manager that cannot hand over is replaced outright. The vault still holds
#    every master descriptor, so a cold-started manager re-adopts the session (ADR-0080).
kill -9 "$NEW_MANAGER_PID" 2>/dev/null || true
wait "$NEW_MANAGER_PID" 2>/dev/null || true
sleep 1
"$NEW/pty-manager" --socket "$MANAGER_SOCK" >"$RUN/cold-manager.log" 2>&1 &
DAEMONS+=($!)

wait_for_sessions "$NEW/pty-status" "$SESSION" "after cold start"
PID_COLD="$(session_pid "$NEW/pty-status")"
[ "$PID_COLD" = "$PID_BEFORE" ] \
    || fail "cold start lost the child process (pid $PID_BEFORE -> ${PID_COLD:-none})"
kill -0 "$PID_BEFORE" 2>/dev/null || fail "the session's child process is gone after a cold start"
echo "PASS: session survived a manager cold start with pid=$PID_COLD"
