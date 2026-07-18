---
status: accepted
date: 2026-07-18
---

# Fragment large Agent feed raw events on the input lane

## Context and Problem Statement

The shared Agent Panel now loads an exact JSONL record only when Raw JSON opens. A record may be as large as 100 MiB, while the authenticated input lane intentionally retains its generic 4 MiB application-frame ceiling. QUIC segments reliable stream bytes below that boundary, but it cannot make an application frame pass a length validator.

## Decision Drivers

- Keep ordinary input, cursor, desktop, and Agent feed messages bounded at 4 MiB.
- Avoid placing complete raw records in 100-event historical pages.
- Use the same dashboard and native request contract on macOS and iOS.
- Fail oversized, incomplete, duplicated, expired, or inconsistent logical transfers visibly.

## Considered Options

- Raise the generic input frame ceiling to 100 MiB and rely only on QUIC segmentation.
- Move raw Agent records to the Files stream and its larger application frame.
- Fragment only large raw-event responses inside the existing Agent push contract.

## Decision Outcome

Use the existing single-frame response when its encoded body fits the 4 MiB input bound. Otherwise the host sends 2 MiB source fragments carrying transfer, request, session, event, part, count, and total-length identity. The iOS transport reassembles at most four concurrent transfers, expires incomplete state after 30 seconds, validates every part and final UTF-8 text, then delivers one ordinary raw-event response to the shared webview. macOS uses the same request and response types in-process without QUIC fragmentation.

The logical record ceiling is 100 MiB. A larger engine response becomes an explicit raw-event error and host log. These additions are optional and initiated only by the new dashboard, so protocol version 9 remains unchanged.

### Consequences

- Good, because interactive input frames keep their existing safety and latency bound.
- Good, because historical pages remain small and raw content crosses the native bridge only on demand.
- Bad, because Agent raw responses now have application-level transfer state in addition to QUIC's transport segmentation.
- Neutral, because the Files stream still uses its separate 101 MiB frame for DOCX and does not share this envelope.

### Confirmation

Wire tests pin label and System round trips, invalid transfer rejection, concurrency and expiry limits, and reconstruction at exactly 100 MiB. Host bridge tests pin direct and fragmented delivery while asserting every input frame remains at or below 4 MiB.

## Links

- SPEC Wire Shapes
- ADR-0030 Single QUIC session transport
- ADR-0035 Phone-side Agent feed
- ADR-0057 Shared responsive DOCX preview over the Files stream
