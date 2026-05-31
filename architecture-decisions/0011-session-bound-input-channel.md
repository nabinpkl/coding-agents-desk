---
status: accepted
date: 2026-05-31
amends:
  - ADR-0003 SessionReady shape
  - ADR-0005 input authentication posture
---

# Session-bound input channel authentication

## Context and Problem Statement

ADR-0003 established that `SessionToken` is an approval-time receipt, not a session authenticator. A live session requires a fresh challenge-response where the client proves possession of the paired device private key. ADR-0005 later split input onto a dedicated WebSocket, but the implemented input path accepts `InputChannelHello { sessionToken }` directly and then feeds `InputChannelEvent` frames into `InputDispatcher`.

This ADR amends only two prior decisions: ADR-0003's empty `SessionReady` shape, and ADR-0005's input-channel auth posture. ADR-0003 remains authoritative for the mutual challenge-response, canonical signing input, UI state machine, and media-plane signaling over the authenticated session WebSocket. ADR-0005 remains authoritative that input events travel on a dedicated WebSocket, separate from video and signaling.

That creates an authentication downgrade on the most sensitive path in the host. The host holds Accessibility permission and can post cursor, keyboard, scroll, drag, and Spaces-switch events. A credential that can be copied from storage must not be enough to open a network input channel.

Scope: `PairingSignalingServer`, `InputChannelServer`, `SessionRegistry`, `SessionAuthenticator`, `SessionDialer`, `Pairing`, the `InputChannelHello` wire shape in shared types, and the session/input sections of `SPEC.md`.

## Findings

- The session WebSocket uses the stronger ADR-0003 model: `SessionInit` plus `SessionChallenge` plus `SessionProof`, with the host verifying the paired device public key before returning `SessionReady`.
- The input WebSocket currently accepts `InputChannelHello` after `Pairing.validate(token:)` succeeds. That validation checks the device is still allowlisted, the token is signed by the host key, and the host fingerprint matches, but it does not prove the caller still holds the paired device private key.
- `SessionRegistry.attachInputChannelServer` replaces any existing input channel for the same fingerprint. With only token possession required, a copied token can disconnect the legitimate input channel and take over input dispatch.
- The listener is intentionally network reachable for Tailscale operation. Network reachability is acceptable only if the control path requires fresh session proof.

## Decision Drivers

- Input dispatch is privileged. The host must not accept input from a long-lived bearer credential alone.
- The dedicated input WebSocket from ADR-0005 remains useful because it isolates input latency from video transport.
- The protocol must keep one source of truth for live trust. A connection is live only after ADR-0003 session proof completes.
- Reconnect must stay under the existing foreground reconnect budget, so the fix cannot require a new QR pairing ceremony for routine reconnects.
- Revocation must keep working by deleting the host allowlist row and tearing down every active session surface for that device. Any derived session or input capability must die when the session dies.

## Considered Options

1. **Status quo bearer input**. Keep `InputChannelHello { sessionToken }` as sufficient proof for input.
2. **Full challenge-response on every input channel**. Run the ADR-0003 proof exchange again on the input WebSocket.
3. **Session-bound input capability**. Require a completed ADR-0003 session first, then have the host mint a random short-lived input capability bound to that active session. `InputChannelHello` presents the capability, not the long-lived `SessionToken`.

### Rejected Boundary Option

**Collapse input onto the authenticated session WebSocket** was rejected as outside this ADR's option set. ADR-0005 makes the dedicated input WebSocket load-bearing: input must remain isolated from WebRTC video and from session signaling so video bursts, SDP/ICE traffic, and host-push state cannot share one ordered stream with high-frequency keyboard, pointer, scroll, and Spaces input. This ADR changes only how the dedicated input WebSocket proves authority.

## Decision Outcome

Chose **Option 3: session-bound input capability**.

The client must complete ADR-0003 session proof before any input channel can open. On `SessionReady`, the host mints a random input capability for that active session and returns it to the client with the session-ready material. `InputChannelHello` changes from `sessionToken` to `{ deviceFingerprint, inputCapability }`. The host accepts the input channel only when all of the following hold:

- The device fingerprint has an active session in `SessionRegistry`.
- The presented input capability matches the active session's current capability.
- The capability is unexpired.
- The paired device is still allowlisted.

`SessionToken` remains an approval receipt and allowlist lookup hint. It is never sufficient by itself to open an input channel or dispatch input.

### Capability Lifecycle and Rotation

`SessionToken` keeps the ADR-0003 role: approval receipt and allowlist lookup hint. This ADR does not add token expiry. Token expiry would change the PRD's pair-once promise, and it is not needed to close the input-channel downgrade because `SessionToken` is no longer sufficient to open input.

The input capability is per-session, short-lived, and stored only in memory. It expires when any of these happens:

- The session ends.
- The host rotates the capability after accepting an input channel.
- The configured input capability TTL elapses.
- The paired device is revoked.

Routine input-channel reconnects request a fresh input capability over the authenticated session channel. That refresh is allowed only while the ADR-0003 session is still active. A standalone input WebSocket cannot refresh itself, and input events never move onto the session channel.

On revocation, the host deletes the allowlist row and immediately terminates the active session in `SessionRegistry`: close the signaling channel, close the input channel server, stop media transport, cancel input tasks, and discard any outstanding capability for that device. Deleting the allowlist row without session teardown is not sufficient.

### Wire Shape

The session ready message gains input-channel capability material:

```
SessionReady {
  inputCapability,
  inputCapabilityExpiresAt
}
```

The authenticated session channel gains low-frequency capability refresh frames:

```
InputCapabilityRefreshRequest {
  deviceFingerprint
}

InputCapabilityGrant {
  inputCapability,
  inputCapabilityExpiresAt
}
```

These frames travel on the ADR-0003 session channel after `SessionReady`, alongside WebRTC signaling frames. They do not carry `NormalizedInput`; `InputChannelEvent` remains exclusive to the dedicated input WebSocket from ADR-0005.

The input hello changes to:

```
InputChannelHello {
  deviceFingerprint,
  inputCapability
}
```

`InputChannelEvent` remains unchanged:

```
InputChannelEvent {
  event: NormalizedInput
}
```

The capability is a random opaque value. It is not derived from `SessionToken`, the device fingerprint, or predictable timestamps.

### Rejection Reasons

The closed rejection vocabulary gains reasons for the new failure modes:

- `expired-input-capability`: the input capability matched a known session but is no longer valid.
- `stale-input-capability`: the input capability was previously valid but has been rotated.

`unauthorized` remains the generic response for malformed, unknown, or non-matching input capability values where revealing state would help an attacker.

### Consequences

- Good, because the input path no longer downgrades from device-key proof to bearer-token proof.
- Good, because a copied `SessionToken` alone cannot dispatch keyboard or mouse input.
- Good, because the dedicated input WebSocket remains in place, preserving ADR-0005's input/video isolation.
- Good, because input reconnect stays cheap while the authenticated session is alive.
- Bad, because the session model now owns extra capability lifecycle state. `SessionRegistry` must track active input capability values, expiry, and rotation.
- Bad, because older clients that send `InputChannelHello { sessionToken }` fail after this lands. This is acceptable before v0.
- Neutral, because `SessionToken` still exists. Its role remains approval receipt and allowlist lookup hint, not input authority.

### Confirmation

The decision is being followed if all of the following are true:

- No host path calls `InputDispatcher.dispatch(_:)` from a connection that has not been bound to an active ADR-0003 session.
- `InputChannelHello` no longer contains `SessionToken`.
- `SessionReady` returns an input capability and expiry for the active session.
- The authenticated session channel accepts `InputCapabilityRefreshRequest` and returns `InputCapabilityGrant` only for the same active device fingerprint.
- Tests prove that a valid `SessionToken` without an active session cannot open an input channel.
- Tests prove that a stale or expired input capability cannot replace an active input channel.
- Tests prove that revocation closes any active signaling channel, input channel, media transport, and input task for the revoked device.
- `SPEC.md` states that `SessionToken.issuedAt` is not an input-channel authority or v0 expiry trigger.

## Pros and Cons of the Options

### Option 1: Status quo bearer input

- Good, because it is already implemented.
- Good, because reconnect is simple.
- Bad, because a copied token is enough to drive a host that has Accessibility permission.
- Bad, because it contradicts ADR-0003's explicit statement that `SessionToken` is not sufficient to authenticate a session.

### Option 2: Full challenge-response on every input channel

- Good, because every input WebSocket proves possession of the paired device key.
- Good, because it avoids another capability type.
- Bad, because it duplicates the session handshake and creates two parallel live-auth mechanisms.
- Bad, because it adds signing work and protocol surface to a reconnect path that only needs to bind back to an already-authenticated session.

### Option 3: Session-bound input capability

- Good, because it keeps one source of live trust: the ADR-0003 session proof.
- Good, because the input channel gets a short-lived, revocable capability instead of a long-lived token.
- Good, because input reconnects remain fast while the session is alive.
- Bad, because capability storage, expiry, and rotation add state to `SessionRegistry`.

## Links

- ADR-0003: session establishment for v0. Amended here only for `SessionReady` capability material and post-ready capability refresh frames. The mutual challenge-response decision remains adopted.
- ADR-0005: input channel separation. Amended here only for input-channel authentication. The dedicated input transport remains mandatory.
- `SPEC.md`: module boundaries for `SessionAuthenticator`, `InputChannelServer`, `SessionRegistry`, and the wire shapes for `SessionReady` and `InputChannelHello`.
- Code findings from 2026-05-31: `PairingSignalingServer.handleInputHello`, `Pairing.validate(token:)`, and `SessionRegistry.attachInputChannelServer`.
