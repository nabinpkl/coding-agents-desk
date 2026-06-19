---
status: accepted
date: 2026-06-18
supersedes: ADR-0012
superseded-by: ADR-0014
---

# Single-surface UDP owned media

## Context and Problem Statement

R24 owned-media testing showed that hardware HEVC can make rest-state text clearer than the tuned software/WebRTC path, but the WebSocket media stream can freeze during scroll and then drain seconds later. The failing layer is the ordered TCP video path, not pairing, input, session authentication, ScreenCaptureKit, or VideoToolbox. This decision locks the R25 media pivot for `host/AgentDeskHost/OwnedMediaTransport.swift`, `host/AgentDeskHost/OwnedMediaChannelServer.swift`, `client/AgentDeskClient/OwnedMediaTransport.swift`, `client/AgentDeskClient/OwnedMediaVideoSink.swift`, `SPEC.md`, and `TASKS.md`.

## Decision Drivers

- Rest-state text crispness is non-negotiable.
- Scroll output must not be blocked behind older video frames.
- Input WebSocket, pairing, auth, Keychain, and Tailscale already work and stay out of the media rewrite.
- The owned path needs fewer moving parts than the dual-plane WebRTC model while the transport hypothesis is tested.
- The media stream must be session-bound even though UDP does not inherit the TLS WebSocket channel.

## Considered Options

- **Keep owned media on WebSocket/TCP.** Preserve reliable ordered delivery and the existing implementation.
- **Use WebRTC data channels for owned media.** Keep SCTP/DTLS and reuse WebRTC transport pieces without RTP video tracks.
- **Use single-surface UDP datagrams.** Send an authenticated full-frame stream over UDP with latest-frame-wins behavior.
- **Build mixed graphics now.** Add dirty regions, scroll-copy, or text-aware primitives immediately.

## Decision Outcome

Chose **single-surface UDP datagrams** because the observed failure is head-of-line blocking in the ordered media path. The owned stack now keeps one logical surface, the detail plane. The client sends `MediaChannelHello` as the first UDP datagram with the existing media capability plus a client nonce. The host validates that capability through `SessionRegistry`, replies with `MediaChannelReady` plus a server nonce, and both sides derive an HMAC key from the media capability and nonces. Encoded `OwnedMediaFrameEnvelope` bytes are split into bounded `ADMD` packets; each packet is authenticated, and stale frame sends stop when a newer frame arrives.

WebRTC remains a baseline, not the strategic owned path. The input WebSocket and authenticated signaling WebSocket stay because they are not the current bottleneck.

### Consequences

- Good, because old video frames no longer block newer ones behind TCP ordering.
- Good, because the owned path has one renderer and one encoded surface, so it avoids the dual-plane restore logic while testing the transport ceiling.
- Good, because the UDP media stream is still bound to the authenticated session through the existing media capability.
- Bad, because reliable delivery, loss handling, and congestion behavior are now AgentDesk's responsibility for this media path.
- Bad, because first implementation sends full frames only. Dirty regions, scroll-copy, or text-aware primitives remain a later escalation.
- Neutral, because the WebRTC dual-plane stack remains available as the measured baseline.

### Confirmation

This decision is being followed if:

- `AGENTDESK_MEDIA_STACK=owned` advertises only `detail` in `SessionReady.mediaPlanes`.
- The signaling server rejects `media-hello` as a WebSocket first frame.
- Owned media video payloads are sent over UDP datagrams, not WebSocket binary frames.
- The client owned sink renders through one `AVSampleBufferDisplayLayer`.
- `just check` covers host and client tests after each change.

## Pros and Cons of the Options

### Keep owned media on WebSocket/TCP

- Good, because it was easy to authenticate and simple to debug.
- Bad, because ordered reliable delivery is exactly the failure shape seen during scroll.

### Use WebRTC data channels for owned media

- Good, because DTLS and NAT handling would stay library-owned.
- Bad, because it keeps the media path inside the WebRTC primitive we are trying to escape.
- Bad, because SCTP reliability and buffering policy would still need careful configuration and measurement.

### Use single-surface UDP datagrams

- Good, because it makes late-frame drop explicit and cheap.
- Good, because it keeps the running system close to the Microsoft/RDP lesson: input/control is reliable, visual motion can discard stale output.
- Bad, because packet loss and pacing are now product code.

### Build mixed graphics now

- Good, because mixed graphics is likely the eventual ceiling for crisp text plus smooth scroll.
- Bad, because it is too large before proving that full-frame hardware video plus datagram pacing cannot meet the feel target.

## Links

- ADR-0004: media transport seams.
- ADR-0005: input channel separation.
- ADR-0011: session-bound input channel authentication.
- ADR-0012: proposed owned media control and reuse map superseded by this concrete R25 transport decision.
- `SPEC.md`: Host MediaTransport, SignalingChannel, Client VideoFrameSink, Client MediaTransport, owned-media wire shapes.
- `TASKS.md`: R25 single-surface datagram media ledger.
