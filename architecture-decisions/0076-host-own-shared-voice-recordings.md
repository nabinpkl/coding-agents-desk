---
status: accepted
date: 2026-07-27
---

# Let the Mac host own shared voice recordings and analysis

## Context and Problem Statement

The shared Gesture/Voice InteractionPanel runs on macOS and iOS, but only the Mac can host the
existing Python voice runtime and durable recording library. Sending iPhone PCM on the input lane
would let reliable audio block cursor, keyboard, and gesture events, while duplicating persistence
or analysis in Swift would create two sources of truth.

## Decision Drivers

- Mac and iPhone captures must produce the same durable recording and analysis shape.
- Input latency must remain independent of reliable audio traffic.
- The Python sidecar must remain loopback-only and reachable from iOS only through an authenticated
  paired session.
- A disconnected or older host must fail visibly without silently switching to on-device analysis.

## Considered Options

- **Option A**: Analyze and store each recording on the device that captured it.
- **Option B**: Carry iPhone voice traffic on the existing input lane.
- **Option C**: Add a dedicated authenticated voice lane that proxies to one host Python authority.

## Decision Outcome

Chose **Option C**. Python owns WAV persistence, full-file MLX Whisper transcription, ZIPA ONNX
phone inference, metadata, and reanalysis for every shared-panel recording. macOS reaches the
loopback sidecar directly. iOS sends the same browser voice messages through native Swift over
additive QUIC stream role `.voice = 7`; the host enforces iPhone source identity and proxies only
allowlisted recording REST paths plus the voice WebSocket.

The outer AgentDesk protocol remains `15` because existing roles and messages are unchanged. The
new lane negotiates `voice-lane-v1` independently. An older host rejects or closes the unknown role,
which the client maps to a bounded “Update the Mac host to use iPhone recording” failure while the
rest of the authenticated session remains usable.

### Consequences

- Good, because both microphones populate one host library with identical transcription and phone
  analysis behavior.
- Good, because audio cannot head-of-line block input events.
- Good, because transport replacement closes the host WebSocket, allowing Python to retain and
  analyze nonempty partial audio as interrupted.
- Bad, because iPhone recording depends on the paired Mac and its voice sidecar being available.
- Neutral, because the native fullscreen Voice/Passage experiment keeps its separate on-device
  files and model chooser.

### Confirmation

Wire tests pin role `7`, lane negotiation, payload limits, and envelope round trips. Python tests
cover source parity, interruption, empty discard, busy rejection, independent stage failures, and
the bundled ZIPA fixture. Host and web tests cover REST allowlisting and chunking, source
enforcement, native request correlation, and shared socket messages. `just check-all` is the
automated gate; the explicit runtime checkpoint covers Mac/iPhone capture, disconnect, busy, and
resource cleanup.

## Links

- ADR-0020
- ADR-0030
- ADR-0050
- `SPEC.md` Host-owned shared voice flow
