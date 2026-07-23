---
status: accepted
date: 2026-07-22
---

# Capture paired-client screenshots on demand

## Context and Problem Statement

The durable diagnostics path records bounded structured evidence, but it cannot show the actual iOS
surface when a renderer, layout, or state-projection bug is visible only on the phone. A paired Mac
needs a deliberate debugging command that can capture the foreground AgentDesk window without adding
continuous screen sharing, background collection, cloud storage, or an unrestricted screenshot API.

This supersedes only ADR-0032's rule that diagnostics never return screen pixels. Its bounded durable
event store and retrieval contract remain unchanged.

## Decision Drivers

- The user must opt in before any paired host can request pixels, and the client must remain the final
  authority at capture time.
- Capture must work through the authenticated live session and through the existing signed foreground
  tailnet fallback when the session lane is unavailable.
- Terminal, browser, workspace, and remote-control surfaces include sensitive content, so screenshots
  must be ephemeral, bounded, visible to the user, and absent from logs and durable client storage.
- One command must collect a screenshot alone or alongside the existing structured diagnostics.
- UIKit and WebKit content must be represented without relying on a system-wide Screen Recording
  permission.

## Considered Options

- **Keep structured diagnostics only.** Continue debugging visual failures from event metadata.
- **Capture the foreground AgentDesk window on demand.** Require explicit client opt-in, authenticate
  each request, and return one bounded image.
- **Stream or periodically upload client pixels.** Add continuous remote observability.

## Decision Outcome

Choose **on-demand foreground-window capture**. The setting **Allow paired Mac screenshots** is off by
default and is checked again for every request. A capture is accepted only while AgentDesk owns a
visible foreground window. UIKit renders that app window and visible `WKWebView` instances contribute
their own WebKit snapshots. System keyboard and system overlay windows are outside the capture. A live
video layer may be absent and is declared in the manifest rather than silently represented as complete.

The client encodes JPEG with a 2,048-pixel long-edge ceiling and a 4 MiB aggregate ceiling. The QUIC
lane uses 256 KiB source chunks; the offer-port fallback uses 32 KiB source chunks so every encoded
JSON frame remains below that transport's existing 64 KiB limit. The manifest carries request identity, capture time, client build SHA, active surface,
pixel dimensions, scale, orientation, MIME type, byte count, SHA-256 digest, and omitted-layer labels.
The host rejects malformed metadata, skipped or duplicate chunks, oversized payloads, and digest
mismatches before writing anything.

Delivery is dual-path and on demand:

- The primary authenticated QUIC input lane carries request, manifest, chunks, and explicit error.
- The foreground offer-port fallback signs the complete request with the paired host key. The client
  validates the stored host fingerprint, signature, bounded clock skew, and one-use nonce before
  capture.

Protocol 14 makes the new request and response frames mandatory. A successful capture posts the
accessible in-app status **Screenshot shared with paired Mac**. The client keeps image bytes in memory
only. The host writes an explicitly requested `/tmp/agentdesk-client-*` directory with mode `0700` and
image and manifest files with mode `0600`. Neither side logs pixels, encoded chunks, typed content, or
clipboard data.

The development entry points are `just client-screenshot [stable|dev]` and
`just client-debug-bundle [stable|dev]`. The latter places the screenshot and bounded durable
diagnostics under one request identifier and private temporary directory.

### Consequences

- Good, because visual client failures can be inspected without a tethered console or manual phone
  screenshot.
- Good, because explicit opt-in, foreground-only capture, authenticated delivery, and an on-screen
  disclosure keep the client in control.
- Good, because strict dimensions, chunks, byte ceilings, digests, and private file modes bound the
  new sensitive-data path.
- Bad, because system keyboard, system overlays, and some live video content cannot be guaranteed in
  the resulting image.
- Neutral, because the host deliberately stores a requested screenshot in `/tmp`; it is ephemeral by
  convention but remains sensitive until the user or operating system removes it.

### Confirmation

- Wire tests round-trip every protocol-14 frame and signed request field.
- Client tests pin default-off authorization, signature and replay rejection, chunking, and capture
  scale bounds.
- Host tests pin manifest validation, ordered chunk assembly, aggregate bounds, SHA-256 verification,
  private output paths, and automation request decoding.
- Repository review must find no screenshot payload or rendered text in diagnostics or unified logs.

## Links

- ADR-0032 Durable client diagnostics.
- ADR-0030 Single QUIC session transport.
- ADR-0020 Wire protocol version negotiated at the session handshake.
- `SPEC.md`
- `TASKS.md`
