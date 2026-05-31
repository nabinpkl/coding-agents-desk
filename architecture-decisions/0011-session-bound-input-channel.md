---
status: accepted
date: 2026-05-31
supersedes: ADR-0003
---

# Session-bound input channel authentication

## Context and Problem Statement

ADR-0003 established that `SessionToken` is an approval-time receipt, not a session authenticator. A live session requires a fresh challenge-response where the client proves possession of the paired device private key. This ADR supersedes ADR-0003's `SessionReady` and rejection-vocabulary decisions while preserving its mutual challenge-response decision. ADR-0005 later split input onto a dedicated WebSocket, but the implemented input path accepts `InputChannelHello { sessionToken }` directly and then feeds `InputChannelEvent` frames into `InputDispatcher`.

That creates an authentication downgrade on the most sensitive path in the host. The host holds Accessibility permission and can post cursor, keyboard, scroll, drag, and Spaces-switch events. A credential that can be copied from storage must not be enough to open a network input channel.

Scope: `PairingSignalingServer`, `InputChannelServer`, `SessionRegistry`, `SessionAuthenticator`, `SessionDialer`, `Pairing`, the `InputChannelHello` wire shape in shared types, and the session/input sections of `SPEC.md`.

## Findings

- The session WebSocket uses the stronger ADR-0003 model: `SessionInit` plus `SessionChallenge` plus `SessionProof`, with the host verifying the paired device public key before returning `SessionReady`.
- The input WebSocket currently accepts `InputChannelHello` after `Pairing.validate(token:)` succeeds. That validation checks the device is still allowlisted, the token is signed by the host key, and the host fingerprint matches, but it does not prove the caller still holds the paired device private key.
- `SessionToken.issuedAt` is informational in the current `SPEC.md` and no expiry is enforced by `Pairing.validate(token:)`.
- `SessionRegistry.attachInputChannelServer` replaces any existing input channel for the same fingerprint. With only token possession required, a copied token can disconnect the legitimate input channel and take over input dispatch.
- The listener is intentionally network reachable for Tailscale operation. Network reachability is acceptable only if the control path requires fresh session proof.

## Decision Drivers

- Input dispatch is privileged. The host must not accept input from a long-lived bearer credential alone.
- The dedicated input WebSocket from ADR-0005 remains useful because it isolates input latency from video transport.
- The protocol must keep one source of truth for live trust. A connection is live only after ADR-0003 session proof completes.
- Reconnect must stay under the existing foreground reconnect budget, so the fix cannot require a new QR pairing ceremony for routine reconnects.
- Revocation must keep working by deleting the host allowlist row. Any derived session or input capability must die when the session dies.
- Tokens need bounded lifetime or rotation so copied credentials lose value over time.

## Considered Options

1. **Status quo bearer input**. Keep `InputChannelHello { sessionToken }` as sufficient proof for input.
2. **Full challenge-response on every input channel**. Run the ADR-0003 proof exchange again on the input WebSocket.
3. **Session-bound input capability**. Require a completed ADR-0003 session first, then have the host mint a random short-lived input capability bound to that active session. `InputChannelHello` presents the capability, not the long-lived `SessionToken`.
4. **Collapse input onto the authenticated session WebSocket**. Remove the separate input socket and carry `InputChannelEvent` frames over the post-`SessionReady` signaling channel.

## Decision Outcome

Chose **Option 3: session-bound input capability**.

The client must complete ADR-0003 session proof before any input channel can open. On `SessionReady`, the host mints a random input capability for that active session and returns it to the client with the session-ready material. `InputChannelHello` changes from `sessionToken` to `{ deviceFingerprint, inputCapability }`. The host accepts the input channel only when all of the following hold:

- The device fingerprint has an active session in `SessionRegistry`.
- The presented input capability matches the active session's current capability.
- The capability is unexpired.
- The paired device is still allowlisted.

`SessionToken` remains an approval receipt and allowlist lookup hint. It is never sufficient by itself to open an input channel or dispatch input.

### Expiry and Rotation

`SessionToken` gains an enforced lifetime. The v0 target is a short human-scale window, defaulting to 30 days from `issuedAt`, stored as a central config constant. When a token expires, the next `SessionInit` is rejected with a closed reason that causes the client to re-pair. This is intentionally not a silent refresh because ADR-0003 treats revocation and approval as explicit host-side trust state.

The input capability is per-session and much shorter lived. It is minted after session proof, stored only in memory, and expires when any of these happens:

- The session ends.
- The input channel closes and reconnects beyond the allowed reconnect window.
- The host rotates the capability after accepting an input channel.
- The configured input capability TTL elapses.

Routine input-channel reconnects may request a fresh input capability over the authenticated session channel. That refresh is allowed only while the ADR-0003 session is still active. A standalone input WebSocket cannot refresh itself.

### Wire Shape

The session ready message gains input-channel capability material:

```
SessionReady {
  inputCapability,
  inputCapabilityExpiresAt
}
```

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

- `expired-token`: the approval receipt is older than the enforced `SessionToken` lifetime.
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
- Neutral, because `SessionToken` still exists. Its role is narrowed to approval receipt and allowlist lookup, with an enforced lifetime.

### Confirmation

The decision is being followed if all of the following are true:

- No host path calls `InputDispatcher.dispatch(_:)` from a connection that has not been bound to an active ADR-0003 session.
- `InputChannelHello` no longer contains `SessionToken`.
- `Pairing.validate(token:)` enforces `SessionToken` lifetime and returns a typed rejection reason for expiry.
- Tests prove that a valid `SessionToken` without an active session cannot open an input channel.
- Tests prove that an expired token is rejected during `SessionInit`.
- Tests prove that a stale or expired input capability cannot replace an active input channel.
- `SPEC.md` states that `SessionToken.issuedAt` is enforced, not informational.

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

### Option 4: Collapse input onto the authenticated session WebSocket

- Good, because the session WebSocket is already authenticated.
- Good, because there is no second input-auth handshake.
- Bad, because it partially reverses ADR-0005 by coupling input delivery to signaling traffic and one socket lifecycle.
- Bad, because it makes future high-frequency input and host-push state share one ordered stream.

## Links

- ADR-0003: session establishment for v0. Superseded here for `SessionReady`, rejection reasons, and input-channel binding. The mutual challenge-response decision remains adopted.
- ADR-0005: input channel separation. This ADR keeps the dedicated input transport but replaces its auth posture.
- `SPEC.md`: module boundaries for `SessionAuthenticator`, `InputChannelServer`, `SessionRegistry`, and the wire shapes for `SessionReady` and `InputChannelHello`.
- Code findings from 2026-05-31: `PairingSignalingServer.handleInputHello`, `Pairing.validate(token:)`, and `SessionRegistry.attachInputChannelServer`.
