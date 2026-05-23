---
status: proposed
date: 2026-05-22
---

# Input channel as dedicated WebSocket, off the WebRTC data channel

## Context and Problem Statement

ADR-0004 placed input on a libwebrtc `RTCDataChannel` carried inside the same `RTCPeerConnection` that ships the SRTP video track. `RTCConfiguration` is unset for bundle policy so the default `.balanced` applies, and unified-plan SDP with `rtcp-mux` forces every media line plus the data channel onto one DTLS/UDP 5-tuple. During R12 (keyboard) hardware testing the typing latency was visibly inconsistent on the developer's iPhone: a fixed cadence of taps produced a "sometimes fast, sometimes slow" pattern on the host, where cursor moves over the same channel felt steady. The split fits the textbook head-of-line / pacer-contention shape. Small SCTP data packets queue behind RTP video bursts at the shared UDP socket, behind the WebRTC pacer, and behind GCC's congestion arbitration; a video keyframe shift in scene complexity can deprioritise data packets enough to be visible to a human typist.

The scope this ADR touches: `client/AgentDeskClient/LibWebRTCMediaTransport.swift`, `host/AgentDeskHost/LibWebRTCMediaTransport.swift`, `host/AgentDeskHost/AppDelegate.swift` (input task source), `client/AgentDeskClient/PairingViewController.swift` (`sendInput` call site), `host/AgentDeskHost/PairingSignalingServer.swift` (new connection classification path). The wire schema (`NormalizedInput` Codable enum in `SharedTypes.swift`) is invariant under this change; only the transport that carries it moves.

Industry has solved this exact problem. NVIDIA GameStream and its open-source client/server pair Moonlight/Sunshine ship video on UDP, audio on UDP, **input on TCP**, and control on TCP, each on its own socket. Steam Remote Play follows the same separation. Parsec's BUD protocol is the exception (custom UDP with internal priority queues plus an in-house congestion controller, multiple years of work). Google Meet's WebRTC stack uses two `RTCPeerConnection`s per session for the same isolation reason; the WebRTC community calls two-PC the "worst case" only because two bandwidth estimators competing on a shared bottleneck is genuinely bad on cross-internet links, a concern that does not apply to a Tailscale direct path between the developer's phone and Mac.

Per `universal-AGENTS.md → Iteration over compatibility`, the pre-v0 window is the right time to fix the architecture, not the time to layer a `RTCDataChannelConfiguration.priority` tweak that papers over a wrong shape. This ADR closes off "input shares transport with video" as a v0 commitment.

## Decision Drivers

- Typing latency must be consistent at human-input rates. The variability observed during R12 testing was disqualifying for the keyboard slice's daily-driver target.
- The fix must isolate input from video at a layer below WebRTC's pacer, since within-pacer priority schemes do not undo OS-queue contention on a shared UDP socket. Anything that leaves the two streams on one 5-tuple is suspect.
- The wire schema is `NormalizedInput`; it does not move. Producers (`GestureTranslator`, `KeyboardSurface`, the right-click button, the accessory row) emit through one delegate path today and must continue to.
- The existing TLS + Tailscale stack (signed certs from `tailscale cert`, `NWListener` on port 41888, the `WebSocketSignalingChannel` shape from ADR-0003) is the path of least implementation cost for any new authenticated transport.
- No backward shims, no `v1 vs v2` toggle, no two transports running side by side. One ships.
- Tests must drive the wire end-to-end without spinning libwebrtc, the same posture ADR-0004 established for the media seams.

## Considered Options

1. **Status quo plus data-channel priority bump.** Set `RTCDataChannelConfiguration.priority = .high` (or the spec's `1024` weight). One config line, no architectural change.
2. **Two `RTCPeerConnection`s per session.** One PC for the video track, one for an input data channel. Each PC gets its own ICE candidate pair, DTLS context, UDP socket.
3. **Custom UDP-with-priority protocol** along the Parsec BUD shape. Single socket, internal priority queue, in-house congestion controller tuned for "small interactive packet must beat big video burst."
4. **Dedicated WebSocket Secure for input.** Video stays on the existing WebRTC PeerConnection unchanged. Input migrates to a second WSS connection on the existing port 41888, opened after session establishment, carrying one JSON-encoded `NormalizedInput` per WebSocket text frame.

## Decision Outcome

Chose **Option 4** because it isolates input from video at the OS-socket level (Driver 2) with the lowest implementation cost given the existing TLS + Tailscale stack (Driver 4). Option 1 was knocked out by Driver 2: the SCTP pacer's weighted-fair-queueing influences within-channel scheduling but does not undo OS-level queueing on the shared UDP socket; observed latency variance comes from the bundled transport, not from pacer arbitration. Option 2 was knocked out by implementation surface plus Driver 4: two PCs solve the contention but introduce two ICE state machines and two DTLS contexts per session, doubling the reconnection complexity; the two-bandwidth-estimator concern matters less on a Tailscale point-to-point link but is non-zero. Option 3 was knocked out by Driver 4: custom UDP-with-priority is the canonical answer for cross-internet game streaming where every millisecond is fought for, but it is months of pacer and congestion-controller work, and the existing TLS-over-Tailscale path already delivers human-input-rate-acceptable latency in isolation.

### Wire shape

A new WebSocket Secure endpoint on the existing signaling port, classified by first frame the way pair and session-init are classified today (no new HTTP path routing introduced).

```
InputChannelHello { token: SessionToken }                       // t: "input-hello"
InputChannelEvent { event: NormalizedInput }                    // t: "input-event"
InputChannelClose { reason: String }                            // t: "input-close" (optional, server side)
```

JSON with compact keys (`t`, `tk`, `ev`, `r`) matching the ADR-0003 convention. Each frame is one WebSocket text message. The first frame on a new connection must be `InputChannelHello`; anything else closes the connection with `SessionRejected(.malformed)`. After the hello is validated against the session registry, subsequent frames are `InputChannelEvent` carrying one `NormalizedInput` per frame.

### Connection lifecycle

The input channel is independent of the video PeerConnection. They share no lifecycle, no reconnection schedule, no auth context (except that both terminate on session revocation).

- **Open.** Client opens the input WSS immediately after `SessionDialer.dial(host:)` returns a valid `ActiveSession`. The first frame is `InputChannelHello` with the session token issued during pairing.
- **Auth.** Host's `PairingSignalingServer` classifies the first frame as `input-hello`, looks up the token in `SessionRegistry`, and either binds the connection to that session's input pipe or closes it with `SessionRejected(.unauthorized)`.
- **Send.** Client `InputChannel.send(_ input:)` encodes one `InputChannelEvent` per `NormalizedInput` and pushes through the WebSocket task. Synchronous from the caller's view.
- **Receive.** Host consumes inbound frames as a `for await frame in inputChannel.events` stream that feeds the existing `InputDispatcher.dispatch(_:)` path. Same dispatch contract that `transport.inputEvents` currently fulfils.
- **Drop.** If the input WSS drops while the session is otherwise alive, client reconnects with the same exponential backoff policy `SessionDialer` already implements (no new policy module). The video PeerConnection keeps running. If the video PC drops, input WSS keeps running; the user can keep typing into a blank trackpad screen and the host will dispatch their events, which is correct behaviour (a key-only session is a real state).
- **Tear down.** On session revocation or pairing forget, both transports close. The `SessionRegistry` is the single point of truth; both transports observe it and self-tear-down.

### Auth posture

The session token is presented inside the first WebSocket text frame, not in the URL or in `Sec-WebSocket-Protocol`. Reasons:

- Matches the existing `/session` handshake shape (first frame is `SessionInit` carrying credentials) so the wire pattern is uniform.
- HTTP-layer headers and URL query strings show up in proxy logs, load balancer logs, and any future telemetry that scrapes the upgrade request. The token must not appear there.
- The token is already a `SessionToken` (ADR-0003); no new credential type is introduced.

### Backpressure

At human-input rates (worst case ~30 events per second at sustained typing, ~60-byte JSON per event), the unsent queue on a WebSocket cannot grow unboundedly. No explicit upper bound is enforced. If the wire is congested the user will see input latency degrade, which is the correct feedback (a queue bound that drops events would silently lose keystrokes; better to feel the lag and reconnect). This is documented in the inline comment at the `InputChannel.send` call site.

### Path naming on the wire

The new endpoint shares the URL path with `/pair` and `/session` (which today are not distinct paths either; both arrive on the same WebSocket accept and are classified by first frame). First-frame classification is the existing convention. Adding URL-path routing to `PairingSignalingServer` would be a parallel mechanism for the same purpose and is rejected. The first-frame discriminator (`type: "input-hello"`) carries the routing intent.

### Protocol surface

Two new protocols, one per side:

```swift
// client/AgentDeskClient/InputChannel.swift
protocol InputChannel: AnyObject {
    func send(_ input: NormalizedInput) async throws
    func close()
    var state: AsyncStream<InputChannelState> { get }
}

enum InputChannelState { case connecting, open, reconnecting, closed }

protocol InputChannelFactory {
    func make(token: SessionToken, host: String) -> InputChannel
}
```

```swift
// host/AgentDeskHost/InputChannelServer.swift -- per-session, owned by SessionRegistry
final class InputChannelServer {
    init(connection: NWConnection, token: SessionToken)
    var events: AsyncStream<NormalizedInput> { get }
    func close()
}
```

`MediaTransport` (ADR-0004) loses its `send(_:)` and `inputEvents` surface. It becomes video-only, as its name now strictly implies. `MediaTransportError.inputChannelNotOpen` and `MediaTransportError.inputEncodeFailed` are removed.

### Composition root

A single file per side adds the new factory binding, mirroring ADR-0004's `MediaStack`:

- Host: `SessionRegistry` is the input channel server's owner; on session establishment it constructs the server, attaches the existing `InputDispatcher` to its events stream via the same `attachInputTask` call site.
- Client: `PairingClient.attemptSession` constructs an `InputChannel` alongside the existing `MediaTransport` and exposes it via the same `ActiveSession` value that already plumbs through to `PairingViewController`. `sendInput(_:)` calls `activeSession.inputChannel.send(_:)` instead of `mediaTransport.send(_:)`.

### Consequences

- Good, because typing latency is decoupled from video bandwidth. Video bursts cannot delay input events because they no longer share a transport.
- Good, because the `MediaTransport` protocol from ADR-0004 simplifies. `send`, `inputEvents`, and two error cases drop. The protocol's name and its surface now align.
- Good, because the new transport reuses the existing TLS + Tailscale stack. No new credential type, no new port, no new key material.
- Good, because the input channel can reconnect independently of the video PC. Today, a video-PC failure forces a full session re-establishment to recover typing; after this ADR, the channels heal independently and the user keeps typing.
- Bad, because two transports now live per session instead of one. Each needs its own lifecycle observer, its own reconnect path, and its own teardown trigger. The complexity moves from "one fat transport" to "two narrow ones," which is the right shape but is more files.
- Bad, because the SCTP-data-channel-input path that R9 landed is deleted. That work is not wasted (it proved the protocol shape and the InputDispatcher contract under load) but the transport-specific code goes.
- Neutral, because the wire schema (`NormalizedInput`) is unchanged. Producers and the host's `InputDispatcher` are invariant under this ADR.

### Confirmation

The decision is being followed if all of the following hold during code review:

- `LibWebRTCMediaTransport` on both sides has no `RTCDataChannel` creation, no `inputEvents` stream, no `send(_ input:)` method. The `MediaTransport` protocol's surface is video-only.
- `InputChannel` (client) and `InputChannelServer` (host) are the only files that own WebSocket connections for input events. `PairingSignalingServer` only routes the upgrade and the first-frame classification; it does not hold input-event state.
- `PairingViewController.sendInput` calls `activeSession.inputChannel.send(_:)`. The previous `mediaTransport?.send(_:)` call site is gone.
- Tests exercising the input channel use an in-memory `InputChannel` fake; they do not spin a WebSocket task or libwebrtc.
- The wire frame discriminators on the input WS are exactly `"input-hello"`, `"input-event"`, `"input-close"`. Adding a fourth discriminator requires an ADR amendment.

Any change to the protocol surface, the `InputChannelState` vocabulary, or the wire frame discriminators requires an ADR that supersedes this one.

## Pros and Cons of the Options

### Option 1: Data-channel priority bump

- Good, because it is a single config line; smallest possible change.
- Good, because no new transport surface is introduced.
- Bad, because it does not isolate input from video at the OS-socket level; SCTP pacer scheduling is downstream of the shared UDP queue and the OS sendmsg buffer.
- Bad, because it addresses the symptom (which packet leaves first) without addressing the cause (the two packets sharing one queue). Variability under video bursts will not fully resolve.
- Bad, because it is the kind of tweak universal-AGENTS.md explicitly cautions against in the "Iteration over compatibility" rule: a layer on top of a wrong shape, kept because the wrong shape has already been chosen.

### Option 2: Two RTCPeerConnections

- Good, because it achieves full OS-socket isolation between video and input; the canonical WebRTC-native answer.
- Good, because it stays inside one stack (libwebrtc) and one credential type.
- Bad, because two bandwidth estimators compete on a shared bottleneck. On a Tailscale direct path this is much less of a concern than the WebRTC community framing suggests, but it is non-zero and observable under any contention with other Tailnet traffic.
- Bad, because it doubles the ICE state machinery per session: two PCs, two SDP exchanges, two ICE candidate pairs, two `MediaConnectionState` machines to observe and tear down. The composition-root complexity rises sharply.
- Neutral, because the wire schema is invariant; the cost is purely in the WebRTC plumbing.

### Option 3: Custom UDP-with-priority

- Good, because it is the canonical answer for cross-internet game streaming where every millisecond counts (Parsec, Steam Remote Play in practice).
- Good, because it gives total control over scheduling between streams.
- Bad, because it is months of work to do well: pacer, congestion controller, retransmission semantics, MTU handling, NAT/firewall traversal. We do not have that runway in v0.
- Bad, because it discards the existing TLS + Tailscale identity stack and re-implements adjacent surface (key exchange or token presentation, framing, ordering).

### Option 4: Dedicated WebSocket Secure for input

- Good, because it isolates input from video at the OS-socket level (two TCP connections through one Tailscale tunnel, no shared queue at the WebRTC layer).
- Good, because it reuses the existing TLS + Tailscale stack and the existing `WebSocketSignalingChannel` shape verbatim; no new credential, no new port, no new wire mechanism.
- Good, because the input channel can reconnect on its own schedule, independent of the video PeerConnection. Today a video-PC drop blocks typing recovery on the WebRTC reconnect; after this ADR they recover independently.
- Bad, because two transports per session is more lifecycle to manage than one. The cost is paid in `PairingClient`, `SessionRegistry`, and the per-side composition roots.
- Bad, because TCP head-of-line within the input WSS itself is now possible (one stuck retransmit holds back later events). At human input rates this is academic; documented in the inline comment.
- Neutral, because the wire schema is unchanged; the migration is transport-only.

## Links

- ADR-0001: stack and transport.
- ADR-0003: session establishment. The input channel reuses the `SessionToken` and the WebSocket framing convention this ADR established.
- ADR-0004: media transport seams. After this ADR, the `MediaTransport` protocol's `send(_:)` and `inputEvents` surface is removed.
- `SPEC.md`: §Module boundaries gains `InputChannel` (client) and `InputChannelServer` (host); the transport seam diagram updates to show two transports per session (video + input).
- `TASKS.md`: R16 opens for the migration with the touch-point sub-tasks.
- agent-learning/maestro-ios-ui-automation.md: the `just ui-flow type-tap-keys` Maestro flow is the regression test for typing latency end to end after this ADR.
- NVIDIA GameStream / Moonlight protocol (separate sockets per stream type): https://github.com/moonlight-stream/moonlight-common-c (no date, ongoing project).
- W3C WebRTC Priority Control API (the priority knob Option 1 would have used): https://www.w3.org/TR/webrtc-priority/ (W3C Working Draft, 2024-10).
- Parsec BUD protocol (custom UDP, Option 3 inspiration): https://parsec.app/blog/a-networking-protocol-built-for-the-lowest-latency-interactive-game-streaming-1fd5a03a6007 (no date verifiable).
