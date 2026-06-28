---
status: accepted
date: 2026-06-27
supersedes: ADR-0011, ADR-0014, ADR-0022, ADR-0025, ADR-0026
---

# Single QUIC session transport

## Context and Problem Statement

The live session is currently split across a TLS WebSocket session channel, a
dedicated TLS WebSocket input channel, a reliable graphics QUIC connection, and
a separate video datagram QUIC connection. Device logs showed that a cellular
path drop resets these transports together, but the host treats media close as
session close and tears down input. That makes Wi-Fi/cellular switching require
closing and reopening the iPhone app.

## Decision Drivers

- v0 is a real-time remote-control session, not a set of independent API calls.
- Input/control must outlive media lane failures and must not queue behind video.
- The transport must have one session lifetime and explicit suspend/resume.
- No backward compatibility layer is required before v0.
- The Mac-initiated pairing offer path is not part of the real-time session and
  can stay plain TCP over the tailnet.

## Decision Outcome

Use one authenticated `NetworkConnection<QUIC>` for each active live session,
with ALPN `agentdesk-session-quic-v2`. Raise the minimum deployment targets to
macOS 26 and iOS 26 so the implementation uses the typed Network framework
QUIC API.

The session connection owns:

- a control stream for signed session establishment, resume, heartbeat, and
  terminal close/revoke messages;
- an input stream for `InputChannelEvent`, `ClientConfig`, and host pushes;
- the connection's QUIC datagram lane for `ADMD` video packets and video
  control messages;
- no reliable graphics stream unless a future crisp-repair layer proves it is
  live data again.

The session state machine is `connecting -> connected -> suspended -> resuming
-> connected`, or `ended` only on grace expiry, backgrounding, explicit forget,
revocation, or authentication failure. Media loss, decoder recovery, keyframe
requests, bitrate changes, and packet repair are lane-local and never end input.

The protocol version is bumped to 2 with minimum-compatible version 2. The old
WebSocket signaling/input and separate media/graphics connection shapes are
deleted rather than kept as fallback paths.

### Consequences

- Good, because one connection lifetime matches the product: one remote-control
  session with logical lanes.
- Good, because QUIC path migration and resume semantics match mobile network
  switching better than multiple TCP sockets.
- Good, because media is demoted to a subordinate lane and no longer owns input
  liveness.
- Bad, because this is a broad transport rewrite and raises the OS floor.
- Bad, because the video datagram lane still needs app-level pacing, repair, and
  adaptation; QUIC does not make video reliable.

### Confirmation

This decision is implemented when:

- host and client deployment targets are macOS 26 / iOS 26;
- the live session listener/dialer uses `NetworkConnection<QUIC>` with ALPN
  `agentdesk-session-quic-v2`;
- the app has no WebSocket session/input fallback and no separate graphics or
  video datagram listener;
- `SessionReady` carries resume/media key material instead of input/media
  capabilities;
- tests prove resume inside the grace window and rejection outside it;
- device logs during Wi-Fi/cellular switching show
  `session suspended -> resuming -> connected`, not `session ended`.

## Links

- ADR-0003 Session establishment.
- ADR-0019 Mac-initiated tailnet pairing.
- ADR-0020 Protocol version negotiation.
- ADR-0029 Capacity survival rung.
- `SPEC.md`
- `TASKS.md`
