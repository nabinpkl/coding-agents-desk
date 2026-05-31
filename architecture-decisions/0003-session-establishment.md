---
status: accepted
date: 2026-05-20
---

# Session establishment for v0

## Context and Problem Statement

ADR-0002 locked the pairing-time cryptography: P-256 Secure Enclave keys on both ends, an in-memory nonce map with 90-second TTL, a one-time `agentdesk://pair` QR URL, and a host allowlist as the single trust record. It deliberately scoped to first-pairing and did not specify the per-connection exchange that happens after pairing. `SPEC.md` filled the gap with a one-line claim: "on foreground, reconnect uses the stored `SessionToken`; no re-pairing." That claim treats `SessionToken` as an HTTP-cookie-like bearer credential.

The S1 implementation followed the bearer-cookie reading literally. `PairingClient.loadStoredSessionIfPresent` jumps from "I have a token on disk" to a `.connected` UI state with no network call. The host symmetrically reads `paired-devices.json` and renders `.connected` even when no client has reached the signaling server in this process lifetime. The first time the two stores disagree (host record cleared, iPhone token retained, or vice versa, or the host re-opens the QR popover while the client still holds a token), both UIs lie in opposite directions and there is no protocol step that surfaces the divergence. The bug is structural, not a missed line of code.

This ADR locks the session-establishment protocol so the same wire shapes that gate the WebRTC peer connection in S2 also fix the UI dishonesty. Scope: a new `SessionAuthenticator` on the host, a new `SessionDialer` on the client, a new path on the existing TLS WebSocket, the four-state UI machine on both ends, and the rejection-reason vocabulary. Does not supersede ADR-0002; extends it.

## Decision Drivers

- Liveness must be provable per connection. A stored credential is not sufficient evidence of a live link.
- The protocol must reuse the long-term P-256 key material established by ADR-0002. No new key types, no new storage layers.
- The session WebSocket must be the gate to WebRTC SDP/ICE exchange so the media plane inherits session authentication without a second handshake.
- Replay protection on the per-connection exchange, equivalent to the QR-time nonce model.
- The UI states must distinguish "I hold credentials" from "I am talking to the host right now." The S1 conflation of the two is the failure mode this ADR closes.
- Revocation must remain one-way and final, consistent with ADR-0002 decision 4 (no token refresh, allowlist is the trust record).

## Considered Options

1. **Per-connection authentication shape.** Bearer-token presentation (S1's accidental design); host-issued challenge with client-only signature; mutual challenge-response with both sides signing fresh nonces; Noise IK over the existing WebSocket.
2. **Role of `SessionToken` going forward.** Delete entirely; retain as approval-time receipt that identifies the device to the host's allowlist lookup; retain and continue using as bearer credential (status quo).
3. **WebRTC binding model.** Bind the DTLS fingerprint via session-signed SDP; run a second authenticated channel inside the WebRTC data channel; trust the WebRTC certificate without binding.
4. **UI state machine cardinality.** Three states (`unpaired | paired | connected`); four states (`unpaired | paired-disconnected | connecting | connected`); five states (add `revoked` terminal).
5. **Rejection vocabulary on the host.** Open-ended error strings; closed set of reasons exposed to the client UI.

## Decision Outcome

**1. Mutual challenge-response, both sides sign fresh nonces.** The client opens a TLS WebSocket to `wss://<host>:<port>/session` and sends `SessionInit { deviceFingerprint, sessionToken, clientNonce }` where `clientNonce` is 32 random bytes. The host looks up the device fingerprint in the allowlist, retrieves the device's stored P-256 public key, and replies with `SessionChallenge { hostNonce, hostSignature }` where `hostSignature` is ECDSA-P256 over the canonical encoding `("agentdesk-session" || clientNonce || hostNonce || hostFingerprint || deviceFingerprint)`. The client verifies the host signature against its cached `hostPublicKey`, then sends `SessionProof { clientSignature }` computed over the same canonical encoding with the device's Secure Enclave key. The host verifies and replies `SessionReady`. The session is now authenticated, both sides have proven possession of the long-term key material established at pairing, and the link is bound to fresh nonces neither side controls in isolation. Bearer-token presentation is rejected on first principles: a credential that can be read off disk is not equivalent to proving possession of an SE-backed key. Host-issued single-side challenge is rejected because the symmetric model is what makes the WebRTC binding in decision 3 work; a one-sided challenge would still leave the client unable to detect a tampered host. Noise IK is rejected because the codebase already has CryptoKit P-256 primitives wired end-to-end per ADR-0002 and the cognitive cost of adding a second crypto stack (Noise patterns, chaining keys, KDF schedules) is not justified for an exchange that runs at most once per app foreground.

**2. `SessionToken` is retained as an approval-time receipt, not an authentication credential.** The token continues to be issued by the host at pairing approval, signed by the host's P-256 key over `(hostFingerprint || deviceFingerprint || issuedAt)`, and stored in the client's Keychain alongside the host public key. Its job in the new model is to identify the device to the host's allowlist lookup during `SessionInit` and to give the host a verifiable record of when this device's approval was granted. It is not sufficient on its own to authenticate a session; the fresh `clientSignature` in `SessionProof` is the authentication. Deleting `SessionToken` outright was considered and rejected because the type and its persistence already exist, the wire shape change to ADR-0002 would be larger than this ADR's footprint warrants, and the receipt property is useful for audit even when not load-bearing for auth. Continuing to use `SessionToken` as a bearer credential is the status quo and is the problem this ADR closes.

**3. WebRTC inherits session authentication via session-signed SDP.** ICE candidates and SDP offers/answers travel only over the authenticated session WebSocket. libwebrtc's SDP carries the DTLS certificate fingerprint as a required field; the session signature implicitly authenticates the fingerprint because the SDP is sent inside a channel whose endpoints proved possession of the long-term keys. The DTLS-SRTP handshake that establishes the media plane then confirms both peers hold private keys matching the SDP fingerprint. The net effect is the WebRTC media channel inherits the session's authentication without a second handshake or a second key store. Running a second authenticated channel inside the data channel was considered and rejected because it would re-derive trust the session already proved and add per-frame overhead. Trusting the WebRTC certificate without binding is rejected on the same MITM grounds that motivate this ADR: the WebRTC certificate is generated per-call, has no pre-established trust anchor, and is only meaningful when authenticated by an outer channel.

**4. Four-state UI machine on both sides.** Client states: `unpaired`, `paired-disconnected`, `connecting`, `connected`. Host states: `unpaired`, `paired-no-active-session`, `connecting`, `connected`. Plus a terminal `revoked` on the client only (the host has no symmetric "I was revoked" since revocation is initiated by the host). On client launch, presence of a stored token transitions to `paired-disconnected`, never directly to `connected`. The `connecting` state is entered on `SessionInit` send and exited on `SessionReady` (to `connected`) or `SessionRejected` (to `revoked` or `unpaired`). Three-state collapses `paired-disconnected` into `connected`, which is the bug this ADR exists to fix. Five states with separate `connecting` and `authenticating` were considered and rejected because the wire exchange is atomic from the user's perspective; a sub-second handshake does not earn UI granularity.

**5. Closed rejection-reason vocabulary.** The host returns `SessionRejected { reason }` with `reason` in `{ "revoked", "unknown-device", "replay", "bad-signature", "malformed" }`. The client maps each reason to a UI transition: `revoked` drops the stored token and host pubkey and goes to `unpaired`; `unknown-device` is treated as `revoked` (the allowlist no longer contains this fingerprint); `replay` retries once with a fresh `clientNonce` then falls through to `paired-disconnected`; `bad-signature` indicates host-key rotation or MITM and drops the stored host pubkey, transitioning to `unpaired`; `malformed` is logged and transitions to `paired-disconnected` without dropping credentials. Open-ended error strings are rejected because the UI cannot respond intelligently to text it does not parse; a closed set makes the state transitions code-reviewable.

**6. Replay protection per handshake.** Each side maintains an in-memory set of nonces seen during the current handshake instance only. A `clientNonce` whose bytes match the most recent one from the same connection is rejected as `replay`. There is no persistence across connections; an attacker capturing a `SessionInit` from the wire gains nothing because they cannot produce the matching `clientSignature` without the Secure Enclave key. This mirrors ADR-0002's nonce TTL model in shape but uses the handshake lifetime as the window rather than 90 seconds, because session handshakes are sub-second.

### Wire shapes

```
SessionInit       { deviceFingerprint, sessionToken, clientNonce }
SessionChallenge  { hostNonce, hostSignature }
SessionProof      { clientSignature }
SessionReady      { }
SessionRejected   { reason }   // reason in { revoked, unknown-device,
                               //             replay, bad-signature, malformed }
```

Encoding: JSON with the same compact single-letter key convention as ADR-0002's `PairingPayload` and `SessionToken`. Path on the existing TLS WebSocket: `/session`, distinct from `/pair`. The TLS identity, port, and listener machinery are reused from ADR-0002 verbatim; no new socket or new port.

Canonical signing input for both sides: the ASCII bytes of `"agentdesk-session"` concatenated with `clientNonce` (32 bytes), `hostNonce` (32 bytes), the ASCII bytes of `hostFingerprint` (64 hex chars), and the ASCII bytes of `deviceFingerprint` (64 hex chars). Total: 209 bytes. Signed once per side per session. Domain-separation prefix `"agentdesk-session"` prevents any future signing-data collision with pairing-time signatures.

### Consequences

- Good, because the UI on each side now reflects an observable fact: `connected` requires a completed signed exchange, not a row on disk. The S1 divergence symptom cannot recur.
- Good, because the WebRTC media plane inherits session authentication without a second handshake. S2 wires SDP/ICE through the authenticated WebSocket and the DTLS fingerprint binding is structural.
- Good, because the long-term key material from ADR-0002 carries all of the protocol's trust. No new keys, no new storage, no rotation story.
- Good, because revocation is final and observable: the next `SessionInit` from a revoked device returns `revoked` and the client tears down its stored credentials in one transition.
- Bad, because every reconnect now pays a sub-second cryptographic handshake (two signatures and two verifications). The 5-second foreground-reconnect budget in `SPEC.md` is unaffected; the handshake budget is roughly 50 ms on Apple Silicon.
- Bad, because `SessionToken` is retained without being load-bearing for authentication. A reader of the code may reasonably wonder why it is still present. Documented here and in `SPEC.md` to forestall that.
- Neutral, because the `replay` reason will, in practice, never fire unless the host is under attack. The code path exists for defense in depth, not for routine handling.

### Confirmation

The decision is being followed if all of the following hold during code review:

- `SessionAuthenticator` exists on the host and `SessionDialer` exists on the client. Neither type contains a code path that emits `.connected` or `SessionReady` without completing the four-message exchange.
- `PairingClient.loadStoredSessionIfPresent` is replaced or renamed to `loadStoredPairingMaterial` and returns the state `paired-disconnected` when credentials are present, never `connected`.
- The host's `/session` endpoint verifies `clientSignature` with ECDSA-P256 against the device public key recovered from the allowlist row matching `deviceFingerprint`. The verification is mandatory; no `.unwrap()` or optional-binding path silently treats a missing public key as a pass.
- The client's `SessionDialer` verifies `hostSignature` with ECDSA-P256 against the cached `hostPublicKey` before sending `SessionProof`. A failed verification returns `bad-signature` before any further bytes are sent.
- `SessionRejected.reason` only contains values from the closed set above. Tests assert each value triggers the documented client UI transition.
- No code path uses `SessionToken` as the sole authentication credential. Tests assert that presenting a valid token without a valid `clientSignature` returns `bad-signature`.

Any change to the handshake shape, the canonical signing input, the rejection vocabulary, or the four-state UI machine requires an ADR that supersedes this one.

## Pros and Cons of the Options

Only the per-connection authentication shape and the WebRTC binding model were close enough to earn this section.

### Per-connection authentication: mutual challenge-response versus Noise IK

- Mutual challenge-response, good: reuses the P-256 CryptoKit primitives already wired by ADR-0002. One signing algorithm in the codebase, one storage location, one verification path. Cognitive footprint stays small.
- Mutual challenge-response, good: the wire shape is four messages, each a JSON object with at most three fields. Reviewable in a single sitting.
- Mutual challenge-response, bad: rolls a bespoke handshake. The construction is well-trodden (it is the SSH user-auth-after-key-exchange pattern, the WebAuthn assertion pattern, and the Bluetooth LE Secure Connections re-bond pattern) but it is not a named, audited primitive.
- Noise IK, good: a named, audited handshake pattern with formal analysis. WireGuard uses it. Tailscale uses NaCl boxes whose security argument is similar.
- Noise IK, bad: introduces a second crypto stack alongside CryptoKit. The Noise codebases for Swift are smaller and less maintained than CryptoKit; the floor of "Noise on iOS" is the floor of whichever Swift Noise library we pull in, not the floor of CryptoKit. Trading a name-brand handshake for a smaller dependency footprint is the wrong direction for a solo project.
- Noise IK, bad: the static-key-of-responder property that makes Noise IK ideal (responder's static public key is known to the initiator a priori) maps cleanly to our model, but adopting Noise means adopting its KDF schedule, chaining values, and rekey policy. None of that pays rent for a per-foreground-reconnect handshake.

### WebRTC binding: session-signed SDP versus secondary handshake inside the data channel

- Session-signed SDP, good: the DTLS fingerprint binding is structural. There is no extra handshake to maintain, no extra channel to authenticate, no second clock for nonce TTLs.
- Session-signed SDP, good: matches the industry pattern. Jitsi, Janus, mediasoup all authenticate signaling and trust the SDP-carried fingerprint.
- Session-signed SDP, bad: the binding is implicit. A reader of the code who does not know that "SDP only travels over the authenticated session" must read the session module to discover that the media plane inherits its auth. Documented here and reinforced in `SPEC.md`.
- Secondary handshake inside the data channel, good: explicit, self-contained. A reader of the WebRTC code sees the auth check inline.
- Secondary handshake inside the data channel, bad: re-derives trust the outer channel already proved. Adds per-connection latency to the media-channel ready signal. The 80 ms glass-to-glass budget in `SPEC.md` becomes harder to hold.

## Links

- ADR-0001: locked the overall stack including libwebrtc and TLS WebSocket signaling.
- ADR-0002: locked pairing-time cryptography; this ADR extends but does not supersede it.
- `SPEC.md`: §Module boundaries (adds `SessionAuthenticator`), §Wire shapes (adds the five session messages), §Lifecycle (rewrites the bearer-token reconnect line). Updated in the same change as this ADR.
- `TASKS.md`: R8 expands into R8.1 through R8.6 as the implementation slices for this ADR.
- GitHub issue #4 (S2): the slice this ADR gates.
- SSH RFC 4252 user authentication, signature-based public-key method: https://www.rfc-editor.org/rfc/rfc4252 (published 2006-01; the structural shape that this ADR's mutual challenge-response generalizes).
- WebAuthn Level 2 assertion ceremony, §6.3.3: https://www.w3.org/TR/webauthn-2/ (recommendation 2021-04-08; the per-assertion challenge model this ADR's session exchange mirrors).
