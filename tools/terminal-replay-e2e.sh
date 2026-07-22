#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:?repository root is required}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
artifacts="${AGENTDESK_TERMINAL_REPLAY_ARTIFACTS:-/tmp/agentdesk-terminal-replay-e2e-$timestamp}"
socket="$artifacts/pty-manager.sock"
manager_log="$artifacts/manager.log"
host_log="$artifacts/host.log"
manager_pid=""
cleanup_ok=false

mkdir -p "$artifacts"

cleanup() {
  local status=$?
  if [[ -S "$socket" && -x "$repo_root/terminal/pty-manager/target/release/pty-client" ]]; then
    "$repo_root/terminal/pty-manager/target/release/pty-client" \
      --socket "$socket" --kill-session terminal-replay-e2e >>"$manager_log" 2>&1 || true
  fi
  if [[ -n "$manager_pid" ]]; then
    kill "$manager_pid" 2>/dev/null || true
    wait "$manager_pid" 2>/dev/null || true
    if kill -0 "$manager_pid" 2>/dev/null; then
      status=1
    else
      cleanup_ok=true
    fi
  fi
  rm -f "$socket"
  if [[ -f "$artifacts/result.json" ]]; then
    /usr/bin/python3 - "$artifacts/result.json" "$cleanup_ok" <<'PY'
import json
import sys

path, cleaned = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    result = json.load(handle)
result["cleanup"] = "verified" if cleaned == "true" else "failed"
if cleaned != "true":
    result["passed"] = False
with open(path, "w", encoding="utf-8") as handle:
    json.dump(result, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
  fi
  echo "terminal-replay-e2e artifacts: $artifacts"
  exit "$status"
}
trap cleanup EXIT INT TERM

swift "$repo_root/tools/agent-window-ax.swift" preflight

cargo build \
  --manifest-path "$repo_root/terminal/pty-manager/Cargo.toml" \
  --release --bin pty-manager --bin pty-client
swift build \
  --package-path "$repo_root/terminal/emulator" \
  --configuration debug \
  --product terminal-replay-harness

manager="$repo_root/terminal/pty-manager/target/release/pty-manager"
harness="$repo_root/terminal/emulator/.build/debug/terminal-replay-harness"

"$manager" \
  --socket "$socket" \
  --client-outbox-frames 4 \
  --client-live-outbox-kibibytes 32 \
  --max-checkpoint-mebibytes 16 \
  --checkpoint-chunk-kibibytes 512 \
  >"$manager_log" 2>&1 &
manager_pid=$!

for _ in $(seq 1 100); do
  [[ -S "$socket" ]] && break
  kill -0 "$manager_pid" 2>/dev/null || { echo "test manager exited" >&2; exit 1; }
  sleep 0.05
done
[[ -S "$socket" ]] || { echo "test manager socket did not appear" >&2; exit 1; }

"$harness" --socket "$socket" --artifacts "$artifacts" --phase initial \
  >>"$host_log" 2>&1
kill -0 "$manager_pid"
"$harness" --socket "$socket" --artifacts "$artifacts" --phase restore \
  >>"$host_log" 2>&1
kill -0 "$manager_pid"

/usr/bin/python3 - "$artifacts/result.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    result = json.load(handle)
assert result["passed"] is True
assert result["ptyPIDBefore"] == result["ptyPIDAfter"]
assert result["restoredWindowCount"] == 2
assert result["restoredWithoutFocusTheft"] is True
assert result["slowClientResynchronizedWithoutReconnect"] is True
assert result["narrowWindowBelowFormerMinimum"] is True
assert result["narrowViewportCroppedAtReadableScale"] is True
assert result["passiveResizePreservedSource"] is True
assert result["ownerResizeAdvancedOnce"] is True
assert result["inactiveInputClaimedBeforeOutput"] is True
assert result["ownershipEpochBeforeRestart"] > 0
assert result["ownerClientIDAfterRestore"] == 0
assert result["columns"] > 0 and result["rows"] > 0
PY

echo "terminal-replay-e2e: PASS"
