---
status: proposed
date: 2026-06-26
# Proposes changing the default and the reliable-channel role from ADR-0025.
# Mark ADR-0025 superseded-by: ADR-0026 only when this is accepted.
refines: ADR-0025
---

# Video-primary owned media: retire the reliable channel

## Context and Problem Statement

Device validation showed pure HEVC video over the QUIC datagram carrier is smooth, responsive, and cheap at rest: static P-frames compress to ~0.5 to 2 KB and the only rest cost is the periodic keyframe, which is tunable via the keyframe interval. So `always_video` is now the baked default (the carrier is the primary media path; tiles are no longer drawn). Under `always_video` the reliable graphics channel carries no frames after the handshake. It is vestigial for **data**, but still load-bearing for **auth**: the reliable handshake is where the session token is verified. The carrier itself accepts any connection and HMACs packets with a **static constant key** (`MediaDatagramCrypto.key` is called with empty `clientNonce`/`serverNonce`), so it is not cryptographically bound to the pairing. This touches `OwnedMediaTransport` (both ends), `OwnedMediaVideoDatagramServer`, `MediaDatagramFramePacket` (crypto), `SharedTypes`, and `Config`.

## Decision Drivers

- Simplicity: if tiles are not the primary path, the tile compositor, copyRect, content cache, and heal/reset coherence are removable complexity.
- Security: the media carrier should be bound to the pairing, not a global static key shared by every install.
- Preserve the validated behavior: video must stay smooth, responsive, and cheap at rest.
- Reversibility: keep a path back to pixel-exact text (a crisp-repair layer) if a constrained link or small-font legibility demands it.
- Transport reality: Network.framework treats a QUIC connection as datagram-mode **or** stream-mode (`isDatagram` is per-connection), so a reliable handshake cannot share the datagram connection.

## Considered Options

- **Option A**: Keep ADR-0025 mixed-mode as the default; `always_video` stays opt-in.
- **Option B**: Video-primary default, keep the reliable channel for the auth handshake. The reliable channel is parked (long idle timeout) and the carrier is kept warm with a client keepalive.
- **Option C**: Video-only. Retire the reliable channel entirely: the carrier derives a per-session key from the pairing, authenticates its own connection, and carries its own handshake; tiles are demoted to an optional crisp-repair layer.

## Decision Outcome

Chose **Option C as the target, reached incrementally**. The current state is **Option B** (the bridge already shipped: `always_video` default, reliable channel parked, carrier keepalive). Option A is rejected because device validation removed its premise: video alone is enough, so paying the mixed-mode complexity by default is unjustified. Option B is a way station, not the destination, because it keeps a vestigial channel alive purely for auth and leaves the carrier on a static key. Option C is the target because it both removes the largest source of complexity (the retained-tile substrate) and fixes the weaker-than-it-looks carrier auth in the same move.

### Consequences

- Good, because one media connection replaces two, and the tile compositor / copyRect / content cache / heal-reset coherence retire with it.
- Good, because the carrier becomes bound to the pairing (per-session key) instead of a global static key.
- Bad, because pure video loses pixel-exact text; recovering it requires adding a crisp-repair layer (the combo), which reuses some retired tile machinery.
- Bad, because a carrier handshake must reimplement a little reliability over datagrams (retry-until-acked hello) or use a transient reliable connection, since streams and datagrams cannot share one connection.
- Neutral, because ADR-0025's carrier mechanism itself is retained; this changes its default and the reliable channel's role, not the datagram transport.

### Confirmation

Accepted-and-executed is observable: the reliable graphics receive loop is gone from `OwnedMediaTransport`, the `idleTimeout` park bridge is removed, `MediaDatagramCrypto.key` is called with real per-session nonces, and a test asserts the carrier rejects an unpaired or forged key. Until those land, status stays `proposed` and ADR-0025 stays un-superseded.

## Follow-up tasks

1. Per-session carrier key: wire `clientNonce`/`serverNonce` (derived from the pairing secret) into `MediaDatagramCrypto.key` on both ends; add carrier-side connection authorization.
2. Carrier handshake: an app-level reliable hello over datagrams (retry-until-acked) carrying the nonces and capability, or a transient reliable connection opened only for the handshake then closed.
3. Retire the reliable graphics receive loop and remove the `idleTimeout` park bridge (commit 682354f) once the carrier is self-sufficient.
4. Crisp-repair layer: tiles become an optional, flag-gated repair pass over settled regions, not the primary substrate.
5. Guardrail tests before full commit: behavior on a deliberately throttled link (average-bitrate motion can burst above the target), and text legibility on small fonts / code.

## Pros and Cons of the Options

### Option A (keep mixed-mode default)

- Good, because crisp text at rest is free and no migration is needed.
- Bad, because device validation showed the mixed-mode complexity is unnecessary for the common case, and it keeps copyRect/tile-coherence as standing cost.

### Option B (video-primary, keep reliable channel for auth)

- Good, because it ships today and is the validated behavior.
- Bad, because it keeps a vestigial channel alive only to host auth, and leaves the carrier on a static key.

### Option C (video-only, carrier self-authenticates)

- Good, because it removes the most complexity and fixes carrier auth together.
- Bad, because it loses pixel-exact text without a repair layer and needs a small reliable-handshake mechanism over datagrams.

## Links

- ADR-0025 mixed-mode hardware video motion (refined by this ADR)
- ADR-0014 QUIC datagram owned media
- Bridge commit 682354f (carrier keepalive + reliable-channel idle-timeout park)
- `always_video` default commit 85c9bfa
