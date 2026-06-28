---
status: accepted
date: 2026-06-27
supersedes: ADR-0019, ADR-0030
---

# Durable client diagnostics

## Context and Problem Statement

The iPhone-side evidence path is currently attached-console logging through
`devicectl --console` and `ownedMediaStderrTrace`. That path is useful during a
 tethered run, but it fails in the cases that matter most: the phone is on
cellular instead of the same Wi-Fi, the app crashes or is force-killed, the app
is reopened later, or the host needs diagnostics after the fact from a live
paired device over Tailscale.

v0 needs first-party diagnostics that survive app restarts, remain bounded on
disk, and can be pulled on demand from the Mac host without introducing cloud
telemetry or third-party SDKs.

## Decision Drivers

- Diagnostics must survive crashes, app relaunches, and non-consoled runs.
- Retrieval must work over the existing tailnet, not depend on same-Wi-Fi or a
  tethered developer console.
- The persisted footprint must stay bounded and self-evicting.
- The evidence must be structured and privacy-scoped: lifecycle, session,
  reconnect, input-lane, repair, decoder, and render-stall essentials, not
  verbose per-packet or per-pixel telemetry.
- No cloud telemetry service or third-party mobile analytics SDK is acceptable
  for v0.

## Considered Options

- **Option A: keep stderr and unified logs only.** Continue relying on attached
  console runs and ad hoc `log collect`.
- **Option B: durable local ring buffer plus on-demand host retrieval.** Persist
  bounded NDJSON on the client, expose retrieval over the active session lane,
  and add a foreground tailnet fallback for paired devices.
- **Option C: third-party telemetry SDK.** Ship crash, log, and breadcrumb data
  to a hosted service.

## Decision Outcome

Chose **Option B**.

The iPhone client owns a first-party `ClientDiagnosticsStore` in
`Application Support/Diagnostics`. It writes structured NDJSON events to the
current run and retains at most two previous runs, with fixed v0 limits:

- 2 MB per run
- 3 runs total (`current` plus two previous)
- 6 MB total retention
- 8 KB maximum serialized event before truncation

Runs use `NSFileProtectionCompleteUntilFirstUserAuthentication`. On bootstrap,
the client rotates any unfinished `current` run into the archive set, starts a
new run, and records `previousRunUncleanExit` if the prior run lacked a clean
shutdown marker. Clean background and termination paths write
`runCleanShutdown`.

Retrieval is dual-path and on-demand only:

- **Primary path:** the authenticated QUIC input lane carries
  `DiagnosticsRequest`, `DiagnosticsSummary`, `DiagnosticsChunk`, and
  `DiagnosticsError`.
- **Fallback path:** the existing offer-port listener becomes a foreground
  tailnet control listener. While the app is foregrounded and paired, it accepts
  an authenticated `diagnostics-request` signed by the paired host key and
  rejects stale timestamps older than 60 seconds.

Chunk payloads are gzipped NDJSON, capped at 48 KB encoded payload per frame
and 768 KB total response unless the host requests less.

MetricKit is additive, not primary. The client registers an
`MXMetricManagerSubscriber` at startup and writes summarized MetricKit crash,
hang, termination, and launch diagnostic counts into the same store when the
system delivers them later.

### Privacy Rules

Persist and return only structured essentials. Do **not** store or send:

- session tokens, signatures, nonces, or other secrets;
- pairing URLs or raw pairing payloads;
- raw media packet payloads, screen pixels, or typed text;
- full hostnames beyond already-paired host/device identifiers already required
  for the live session.

### Consequences

- Good, because crash and freeze evidence survives app relaunch and can be
  requested later from the Mac.
- Good, because the host reuses existing trust material and Tailscale reachability.
- Good, because the retention policy is bounded and self-evicting.
- Bad, because the tailnet fallback is foreground-only. iOS still cannot act as
  an always-on background server.
- Neutral, because attached-console logging remains useful for development but
  is no longer the only evidence path.

### Confirmation

This decision is implemented when:

- the client persists bounded NDJSON runs with `runStarted`,
  `runCleanShutdown`, and `previousRunUncleanExit`;
- the host can request diagnostics over the active session input lane and, if
  needed, over the foreground tailnet control listener;
- prior unclean runs are announced after reconnect and remain available until
  the host retrieves them or bounded retention evicts them;
- MetricKit summaries land in the same store;
- no third-party telemetry SDK is added.

## Links

- ADR-0019 Mac-initiated tailnet pairing.
- ADR-0030 Single QUIC session transport.
- `SPEC.md`
- `TASKS.md`
