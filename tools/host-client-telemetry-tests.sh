#!/usr/bin/env bash
set -euo pipefail

fixture="$(mktemp -d /tmp/agentdesk-host-client-telemetry-test.XXXXXX)"
cleanup() {
  rm -rf "$fixture"
}
trap cleanup EXIT

root="$fixture/cache"
device="$root/device"
run="$device/runs/run-1"
output="$fixture/output"
mkdir -p "$run"

printf '%s\n' \
  '{"hostReceivedAt":1000,"deviceFingerprint":"device","kind":"sessionReady","sessionId":"session-1"}' \
  '{"hostReceivedAt":1001,"deviceFingerprint":"device","kind":"inputLaneReady","sessionId":"session-1"}' \
  '{"hostReceivedAt":1002,"deviceFingerprint":"device","kind":"firstFrameSent","sessionId":"session-1","frameId":1}' \
  '{"hostReceivedAt":1003,"deviceFingerprint":"device","kind":"firstFrameAcknowledged","sessionId":"session-1","frameId":1}' \
  '{"hostReceivedAt":1004,"deviceFingerprint":"device","kind":"clientCheckpoint","clientRunId":"run-1","checkpoint":{"rid":"run-1","mv":"1.2.3","bn":"4","sha":"abc1234","sp":"foreground","ps":"connected","as":"control","rc":true,"rh":true,"rl":true,"hc":4,"ms":"started","vm":"frame-completed"}}' \
  '{"hostReceivedAt":1005,"deviceFingerprint":"device","kind":"inputLaneClosed","sessionId":"session-1","errorCode":"input-lane-ended"}' \
  > "$device/timeline.ndjson"

printf '%s\n' \
  '{"rid":"run-1","sa":900,"ea":1005,"cs":false,"bc":200,"ec":2}' \
  > "$run/summary.json"

printf '%s\n' \
  '{"ts":1004,"runId":"run-1","type":"voicePhoneAnalysisStage","fields":{"stage":"inferenceStarted"}}' \
  '{"ts":1006,"runId":"run-1","type":"previousRunUncleanExit","fields":{}}' \
  | gzip -c > "$run/client.ndjson.gz"

AGENTDESK_HOST_CLIENT_TELEMETRY_ROOT="$root" \
AGENTDESK_HOST_CLIENT_TELEMETRY_OUTPUT="$output" \
AGENTDESK_HOST_CLIENT_TELEMETRY_SKIP_HOST_LOG=1 \
AGENTDESK_HOST_BUNDLE_ID=com.example.agentdesk.AgentDeskHost \
  bash tools/host-client-telemetry.sh stable >/dev/null

/usr/bin/python3 - "$output/incident-summary.json" <<'PY'
import json
import pathlib
import sys

summary = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
assert summary["session"]["sessionReady"] is True
assert summary["session"]["firstFrameSent"] is True
assert summary["session"]["firstFrameAcknowledged"] is True
assert summary["client"]["lastPhoneAnalysisStage"] == "inferenceStarted"
assert summary["classifications"]["railConfiguredButHidden"] is True
assert summary["classifications"]["frameReachedClientButNotEnqueued"] is True
assert summary["classifications"]["priorRunUncleanExit"] is True
assert summary["classifications"]["presentationAttemptObserved"] is False
PY
