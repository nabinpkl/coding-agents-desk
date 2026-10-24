---
name: logs
description: Use for AgentDesk log inspection, simulator or physical run verification, client video freeze diagnosis, durable diagnostics retrieval, and host/client media telemetry review.
---

# Logs

Use this skill to collect AgentDesk evidence without confusing the Mac host log store, the simulated-device log store, attached console output, and durable client diagnostics.

## Guardrails

- Read repo `AGENTS.md` before launching anything. Physical device install, launch, rebuild, relaunch, or reinstall commands require explicit user go-ahead.
- Simulator runs are allowed only when the user explicitly asked for simulator validation, or when the current repo instruction permits it for the task.
- Use `/usr/bin/log`, never bare `log`, for Mac host unified logs.
- Treat `/tmp/agentdesk-sim-console.log` as attached stdout/stderr only. It is not the full simulator OSLog stream.
- Preserve artifact paths in the report. Do not summarize from memory when files exist.

## Fast Triage

1. Confirm the active processes and branch:

```sh
git status --short --branch
pgrep -fl 'AgentDeskHost|AgentDeskClient|simctl launch'
```

2. Identify the run type:

- Simulator attached console: `just sim-fresh-install` or `just sim-console-run`.
- Physical attached console: `just iphone-console-run <variant>` or `just fresh-release-diagnostic-run` (stable, Release) / `just fresh-diagnostic-run-dev` (dev, Debug).
- Physical non-consoled: user ran `just fresh-install[-dev]`, then use durable diagnostics.

3. Use the right log source:

| Evidence | Command/source |
| --- | --- |
| Mac host unified logs | `/usr/bin/log show ... process == "AgentDeskHost"` |
| Simulator client OSLog | `xcrun simctl spawn <UDID> log show --info ...` |
| Simulator stdout/stderr | `/tmp/agentdesk-sim-console.log` |
| Physical attached client console | `/tmp/agentdesk-client-console.log` |
| Non-consoled client diagnostics | `just client-diagnostics <variant>` and `/tmp/agentdesk-client-diagnostics-*` |
| Simulator client durable store | `xcrun simctl get_app_container <UDID> <bundle-id> data` then `Library/Application Support/AgentDesk/Diagnostics/current.ndjson` |

## Simulator Workflow

Use the repo-configured simulator UDID from the `Justfile` unless the user gave a specific one.

Launch when requested:

```sh
just sim-fresh-install
```

If the launch blocks by design, sample logs from another shell/thread, then terminate cleanly after the observation window.

The host and client log under their bundle ids, which come from this checkout's `.env` (`AGENTDESK_BUNDLE_PREFIX`). Read them first; the commands below use them:

```sh
HOST_ID="$(just --evaluate host_bundle_id)"
CLIENT_ID="$(just --evaluate client_bundle_id)"
```

Collect host media send evidence:

```sh
/usr/bin/log show --last 5m --style compact \
  --predicate "subsystem == \"$HOST_ID\" AND category == \"owned-media\""
```

Collect simulator client diagnostics OSLog. Include `--info`; `mediaSummary` is logged at info level:

```sh
xcrun simctl spawn <UDID> log show --info --last 30m --style compact \
  --predicate "subsystem == \"$CLIENT_ID\" AND category == \"client-diagnostics\""
```

Collect simulator CoreMedia presentation evidence:

```sh
xcrun simctl spawn <UDID> log show --last 10m --style compact \
  --predicate 'process == "AgentDeskClient" AND (eventMessage CONTAINS "FigVideoQueueGMStats" OR eventMessage CONTAINS "piqca_gmstats_dump" OR eventMessage CONTAINS "frames decoded")'
```

Read simulator durable diagnostics directly:

```sh
DATA="$(xcrun simctl get_app_container <UDID> "$CLIENT_ID" data)"
jq -r 'select(.type == "mediaSummary" or .type == "mediaLinkHealthSummary" or .type == "videoRenderStall" or .type == "videoFrameDropped" or .type == "videoDecoderRecovered") | [.ts,.type,(.fields|tostring)] | @tsv' \
  "$DATA/Library/Application Support/AgentDesk/Diagnostics/current.ndjson"
```

Interpretation:

- `unrecognised property key` in `/tmp/agentdesk-sim-console.log` alone does not prove app failure. Check whether `AgentDeskClient` stayed running and whether simulator OSLog/durable diagnostics advanced.
- A pass for media-freeze validation needs both host send continuity and client receive/render continuity when available.
- Useful client pass signals: `mediaSummary` near the end with nonzero `fps` and `receivedKbps`, `droppedFrames=0`, `mediaLinkHealthSummary expiredFrames=0`, and CoreMedia lines showing frames enqueued/displayed/decoded.

## Physical Workflow

Do not launch or reinstall the phone unless the user explicitly says to run it.

For a user-run non-consoled physical session, collect after the fact:

```sh
just client-diagnostics dev
/usr/bin/log show --last 20m --style compact \
  --predicate "process == \"AgentDeskHost\" OR subsystem == \"$HOST_ID\""
```

For an attached physical console run, preserve:

- `/tmp/agentdesk-client-console.log`
- host unified log export from the same time window
- any `/tmp/agentdesk-client-diagnostics-*` directory if `just client-diagnostics <variant>` succeeds

## Freeze Verdict Checklist

Report pass/fail with exact timestamps and artifact paths.

Old host-drain freeze shape:

- Host sends stop while session remains open.
- Client `mediaSummary` drops to `fps=0` or near zero and `receivedKbps=0` or near zero.
- Packet repair expiry appears and no recovery follows.
- Session later fails with POSIX timeout 60.

Healthy shape:

- Host `owned media video sent frame=...` keeps increasing near the end of the observation window.
- Periodic keyframes continue landing.
- Client `mediaSummary` remains nonzero near the end.
- Link health reports completed frames and zero expired frames.
- CoreMedia simulator logs show frames enqueued/displayed/decoded with dropped 0.

## Report Shape

Keep the report short:

- Commands run.
- Runtime window.
- Artifact paths.
- Host verdict.
- Client verdict.
- Any warning that is noise versus any warning tied to a failed signal.
