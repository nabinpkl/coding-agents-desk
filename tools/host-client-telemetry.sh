#!/usr/bin/env bash
set -euo pipefail
umask 077

variant="${1:-stable}"
case "$variant" in
  # The Justfile derives both ids from AGENTDESK_BUNDLE_PREFIX and exports them to its recipes.
  stable)
    bundle_id="${AGENTDESK_HOST_BUNDLE_ID:?unset; run this through just, which exports it}"
    ;;
  dev)
    bundle_id="${AGENTDESK_HOST_DEV_BUNDLE_ID:?unset; run this through just, which exports it}"
    ;;
  *)
    echo "variant must be stable or dev" >&2
    exit 2
    ;;
esac

application_support="$(/usr/bin/python3 -c 'import os; print(os.path.expanduser("~/Library/Application Support"))')"
telemetry_root="${AGENTDESK_HOST_CLIENT_TELEMETRY_ROOT:-$application_support/$bundle_id/ClientTelemetry}"
test -d "$telemetry_root" || {
  echo "no host-retained client telemetry at $telemetry_root" >&2
  exit 1
}

device_directory="$(find "$telemetry_root" -mindepth 1 -maxdepth 1 -type d -exec stat -f '%m %N' {} + | sort -nr | head -1 | cut -d' ' -f2-)"
test -n "$device_directory" || {
  echo "no retained client device directory" >&2
  exit 1
}

timestamp="$(date +%Y%m%d-%H%M%S)"
output_directory="${AGENTDESK_HOST_CLIENT_TELEMETRY_OUTPUT:-/tmp/agentdesk-host-client-telemetry-$timestamp}"
test ! -e "$output_directory" || {
  echo "output already exists: $output_directory" >&2
  exit 1
}
mkdir -p "$output_directory"
cp -R "$device_directory" "$output_directory/client-cache"

/usr/bin/python3 - "$output_directory/client-cache" "$output_directory/incident-summary.json" <<'PY'
import gzip
import json
import pathlib
import sys

cache = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
events = []
timeline = cache / "timeline.ndjson"
if timeline.exists():
    for raw in timeline.read_text(encoding="utf-8").splitlines():
        try:
            events.append(json.loads(raw))
        except json.JSONDecodeError:
            pass

last_session_start = max(
    (index for index, event in enumerate(events) if event.get("kind") == "sessionReady"),
    default=0,
)
session_events = events[last_session_start:]
checkpoints = [event["checkpoint"] for event in session_events if event.get("checkpoint")]
latest = checkpoints[-1] if checkpoints else {}
client_events = []
for payload in sorted(cache.glob("runs/*/client.ndjson.gz")):
    try:
        with gzip.open(payload, "rt", encoding="utf-8") as stream:
            client_events.extend(json.loads(line) for line in stream if line.strip())
    except (OSError, json.JSONDecodeError):
        pass

analysis_stages = [
    event.get("fields", {}).get("stage")
    for event in client_events
    if event.get("type") == "voicePhoneAnalysisStage"
]
metric_crashes = [
    event.get("fields", {})
    for event in client_events
    if event.get("type") == "metricKitCrash"
]
run_summaries = []
for summary_path in sorted(cache.glob("runs/*/summary.json")):
    try:
        run_summaries.append(json.loads(summary_path.read_text(encoding="utf-8")))
    except json.JSONDecodeError:
        pass

milestone_rank = {
    "none": 0,
    "frame-completed": 1,
    "decoder-enqueued": 2,
    "presentation-attempted": 3,
}
highest_milestone = max(
    (checkpoint.get("vm", "none") for checkpoint in checkpoints),
    key=lambda value: milestone_rank.get(value, -1),
    default="none",
)
kind_present = lambda kind: any(event.get("kind") == kind for event in session_events)
scene_backgrounded = any(
    checkpoint.get("sp") == "background" for checkpoint in checkpoints
)
previous_unclean = any(
    event.get("type") == "previousRunUncleanExit" for event in client_events
)
rail_configured_hidden = any(
    checkpoint.get("rc") is True and checkpoint.get("rh") is True
    for checkpoint in checkpoints
)
classifications = {
    "transportNeverConnected": not kind_present("inputLaneReady"),
    "railConfiguredButHidden": rail_configured_hidden,
    "frameReachedClientButNotEnqueued": (
        highest_milestone == "frame-completed"
    ),
    "frameEnqueuedWithoutPresentationAttempt": (
        highest_milestone == "decoder-enqueued"
    ),
    "presentationAttemptObserved": highest_milestone == "presentation-attempted",
    "cleanBackground": scene_backgrounded and kind_present("inputLaneClosed"),
    "priorRunUncleanExit": previous_unclean,
    "telemetryEndedBeforeDecisiveBoundary": (
        kind_present("inputLaneClosed")
        and not scene_backgrounded
        and highest_milestone == "none"
    ),
}
received_times = [
    event.get("hostReceivedAt")
    for event in session_events
    if isinstance(event.get("hostReceivedAt"), int)
]
summary = {
    "schemaVersion": 1,
    "evidenceSemantics": "Missing checkpoints mean not observed, not that the transition did not happen.",
    "session": {
        "sessionId": next(
            (
                event.get("sessionId")
                for event in reversed(session_events)
                if event.get("sessionId")
            ),
            None,
        ),
        "sessionReady": kind_present("sessionReady"),
        "inputLaneReady": kind_present("inputLaneReady"),
        "inputLaneClosed": kind_present("inputLaneClosed"),
        "firstFrameSent": kind_present("firstFrameSent"),
        "firstFrameAcknowledged": any(
            event.get("kind") == "firstFrameAcknowledged" for event in session_events
        ),
        "automaticIngestCompleted": any(
            event.get("kind") == "automaticIngestCompleted" for event in session_events
        ),
        "hostLogStartEpoch": min(received_times) - 30 if received_times else None,
        "hostLogEndEpoch": max(received_times) + 30 if received_times else None,
    },
    "client": {
        "runId": latest.get("rid"),
        "marketingVersion": latest.get("mv"),
        "buildNumber": latest.get("bn"),
        "gitSHA": latest.get("sha"),
        "scenePhase": latest.get("sp"),
        "pairingState": latest.get("ps"),
        "activeSurface": latest.get("as"),
        "railConfigured": latest.get("rc"),
        "railHidden": latest.get("rh"),
        "railLayoutReady": latest.get("rl"),
        "hostSurfaceCount": latest.get("hc"),
        "mediaState": latest.get("ms"),
        "videoMilestone": latest.get("vm"),
        "highestVideoMilestone": highest_milestone,
        "lastPhoneAnalysisStage": analysis_stages[-1] if analysis_stages else None,
        "metricKitCrashes": metric_crashes,
    },
    "runSummaries": run_summaries,
    "classifications": classifications,
}
destination.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

IFS=$'\t' read -r log_start log_end < <(
  /usr/bin/python3 - "$output_directory/incident-summary.json" <<'PY'
import datetime
import json
import pathlib
import sys

summary = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
session = summary["session"]
start = session.get("hostLogStartEpoch")
end = session.get("hostLogEndEpoch")
if start is not None and end is not None:
    formatter = lambda value: datetime.datetime.fromtimestamp(value).strftime("%Y-%m-%d %H:%M:%S")
    print(f"{formatter(start)}\t{formatter(end)}")
PY
)

if [ "${AGENTDESK_HOST_CLIENT_TELEMETRY_SKIP_HOST_LOG:-0}" = "1" ]; then
  : > "$output_directory/host-unified.log"
elif [ -n "${log_start:-}" ] && [ -n "${log_end:-}" ]; then
  /usr/bin/log show \
    --start "$log_start" \
    --end "$log_end" \
    --style json \
    --predicate "subsystem == \"$bundle_id\"" \
    > "$output_directory/host-unified.log"
else
  /usr/bin/log show \
    --last 1h \
    --style json \
    --predicate "subsystem == \"$bundle_id\"" \
    > "$output_directory/host-unified.log"
fi

chmod -R go-rwx "$output_directory"
echo "Host/client telemetry bundle: $output_directory"
cat "$output_directory/incident-summary.json"
