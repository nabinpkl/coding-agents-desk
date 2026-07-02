---
status: proposed
date: 2026-07-02
---

# DOM-mirror diagnostic status line on the Browser surface

## Context

The Browser surface can render empty for several distinct reasons (mirroring off,
extension not connected to the host bridge, connected but not recording, recording
but paused, or just idle), and today there is no way to tell them apart from the
phone. "Extension reachable" in particular is host-only knowledge the client never
sees.

## Decision

Add a compact, color-coded status line at the top of the Browser surface (below the
Control | Agent | Browser switcher), driven by a mix of host-pushed and
client-observed signals.

One new host->client frame on the `.dom` lane: `{ "t":"dom-status", "ext":Bool,
"tab":Int? }` (`DomStatusEnvelope` host / `DomStatus` client). `ext` = the
native-messaging bridge to the extension is connected; `tab` = recording tab id
(nil when none). `DomMirrorRelay` tracks both and fans a status frame to attached
lanes on **lane attach**, **bridge connect/disconnect** (`DomBridgeServer`'s
existing `onBridgeConnected`/`onBridgeDisconnected`, wired in `AppDelegate`), and
**recording-tab change** (from `envelope.tabId` on ingest — a batch implies the
extension is reachable and recording). No extension change: the host already knows
bridge liveness and the tab from batch envelopes.

Client-observed signals need no wire: batch freshness ("Xs ago", refreshed by a 1s
timer), batch count (liveness/throughput), node count (the existing replayer
probe), and capture paused (ADR-0045). `DomMirrorClient`'s receive loop is
generalized from "decode as batch or stop" to a `t`-tag switch: `dom-batch` ->
forward, `dom-status` -> update (does not stop the lane), anything else -> stop.

The surface owns its status state and re-renders pills via a pure, unit-tested
`statusChips(DomMirrorStatus) -> [StatusChip]` (severity ok/warn/off -> color),
matching the `visibility(for:)` testable-seam pattern.

Chip semantics (deliberate, after felt review): there is **no "mirror on" chip** --
the Browser segment only exists when the `.dom` lane is open, so its presence
already says mirroring is enabled. The bridge chip is labeled **"bridge"**, not
"ext", because the extension opens its native-messaging port lazily on the first
batch, so the host only sees it **while the extension is streaming** -- "bridge ✗"
means "nothing streaming to the host", which is not the same as "extension not
installed". The recorder is single-tab (v1), so the recording tab is shown by id
(`rec tab N`) rather than a count.

## Consequences

- The phone can distinguish "extension not connected" from "connected but idle"
  from "recording, N nodes, 2s ago" from "paused" at a glance.
- One new lane frame type, backward compatible: an old client treats an unknown
  frame as lane-close (prior behavior); a new client tolerates a host that never
  sends `dom-status` (all client-observed chips still work, `ext` shows unreachable
  until the first status arrives).
- Client only; no extension change. Relates to ADR-0038 (DOM lane), ADR-0040
  (client->host reverse channel), ADR-0045 (capture pause/resume).
