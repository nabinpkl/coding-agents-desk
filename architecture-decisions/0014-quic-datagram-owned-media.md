---
status: accepted
date: 2026-06-18
supersedes: ADR-0013
---

# QUIC datagram owned media

## Context and Problem Statement

The raw UDP owned-media slice removed TCP head-of-line blocking, but physical-device testing showed a worse failure under repeated scroll: output could freeze after packet loss, then stay dependent on a later keyframe. The affected surfaces are `host/AgentDeskHost/OwnedMediaTransport.swift`, `host/AgentDeskHost/OwnedMediaChannelServer.swift`, `client/AgentDeskClient/OwnedMediaTransport.swift`, `SPEC.md`, and `TASKS.md`.

## Decision Drivers

- Owned mode keeps one detail surface, no dual rest/motion plane.
- Video bytes do not travel over TCP or WebSocket.
- Pairing, session auth, media capability validation, input WebSocket, and Tailscale remain reused.
- The media carrier needs congestion behavior that raw UDP does not provide.
- The receiver needs a feedback path to ask for a keyframe after incomplete frames.

## Considered Options

- **Keep raw UDP and tune packet pressure**: continue capture scale, bitrate, FPS, keyframe interval, and pacing probes.
- **Raise the app to the iOS 26/macOS 26 QUIC API now**: use the newest typed QUIC API immediately.
- **Use QUIC datagrams through `NWProtocolQUIC`**: replace raw UDP with QUIC datagrams on the existing deploy targets and add receiver keyframe feedback.
- **Return to reliable stream media over TCP or QUIC stream**: make delivery reliable and ordered again.

## Decision Outcome

Chose **QUIC datagrams through `NWProtocolQUIC`** because the current iOS 17/macOS 14 deployment targets already support the required datagram primitive. The host listens for QUIC datagrams on the signaling UDP port with the same Tailscale-issued TLS identity as the WebSocket server. The client connects with the same media capability handshake, receives `ADMD` chunks as QUIC datagrams, and sends `OwnedMediaControlMessage(kind: keyframe-request)` when it abandons an incomplete frame. After loss, the client discards complete delta frames until a keyframe arrives, so the decoder is not fed frames that depend on missing references.

### Consequences

- Good, because QUIC adds transport-level congestion behavior while keeping stale-frame discard semantics.
- Good, because the implementation does not require an iOS 26 deployment-target jump.
- Good, because loss now creates an immediate keyframe request instead of waiting for the periodic keyframe interval.
- Bad, because QUIC datagrams still do not retransmit video payloads; application-level recovery remains needed.
- Bad, because the current control message rides the datagram association and is repeated rather than guaranteed.
- Neutral, because the `ADMF` envelope and `ADMD` chunk shape stay unchanged for this slice.

### Confirmation

This decision is being followed if:

- `OwnedMediaTransport` uses `NWProtocolQUIC.Options` with `isDatagram = true`.
- The owned host media listener uses the existing TLS identity and media capability validation.
- The client sends an owned-media keyframe request after abandoning an incomplete frame.
- The client suppresses post-loss delta frames until a keyframe arrives.
- `just check` passes.

## Pros and Cons of the Options

### Keep raw UDP and tune packet pressure

- Good, because it is the smallest code delta.
- Bad, because the reduced-pressure run still froze, so packet count alone did not address missing recovery.

### Raise the app to the iOS 26/macOS 26 QUIC API now

- Good, because the newer API may provide cleaner QUIC composition.
- Bad, because the needed datagram primitive is already available on the current deploy targets.
- Bad, because raising targets would make the test population smaller before the transport hypothesis is proved.

### Use QUIC datagrams through `NWProtocolQUIC`

- Good, because it replaces raw UDP with a platform transport that still preserves datagram semantics.
- Good, because it can reuse the existing TLS identity and media capability handshake.
- Bad, because it does not automatically provide RTP-style recovery, NACK, FEC, or guaranteed control delivery.

### Return to reliable stream media over TCP or QUIC stream

- Good, because it would avoid incomplete frames.
- Bad, because ordered reliable video is the failure mode that caused the owned-media pivot.

## Links

- ADR-0004: media transport seams.
- ADR-0011: session-bound input channel authentication.
- ADR-0013: single-surface UDP owned media, superseded by this decision.
- `SPEC.md`: owned media transport and wire shapes.
- `TASKS.md`: R25 media-output friction ledger.
