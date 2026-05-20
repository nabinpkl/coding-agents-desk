---
status: accepted
date: 2026-05-20
---

# Pairing crypto for v0

## Context and Problem Statement

ADR-0001 locked the seven coupled stack decisions for v0, including "QR + Keychain pairing" at the level of "what mechanism." It did not lock the cryptographic details. `SPEC.md` declares `PairingPayload` and `SessionToken` shapes but leaves the algorithm, the key storage, the token lifetime, the tailnet hostname format, and the replay-protection model unspecified. The S1 (issue #3) implementation cannot start without those choices because Codex would otherwise pick them on the user's behalf and the wrong picks (Ed25519 with no hardware backing, expiring tokens with refresh logic, MagicDNS-only hostnames) would land before review. This ADR locks the six pairing-crypto decisions in one document so the S1 brief is a straight translation. Scope: `Pairing` module on host and `PairingClient` module on iOS, the QR payload, the `SessionToken` schema, and the host's paired-device allowlist.

## Decision Drivers

- Hardware-backed signing for the host's private key so a Mac compromise short of physical Secure Enclave attack cannot exfiltrate the signing key.
- Symmetry between host and client primitives so the wire shape is one schema, not two.
- One user, one host, one paired device. No key rotation, no token refresh, no multi-tenant story.
- Pairing must work whether MagicDNS is enabled on the tailnet or not.
- Replay protection on the QR-bearing handshake (the QR is shown in physical space; a passing observer's screenshot must not be reusable).
- Minimum new state. Every persisted record is a maintenance liability.

## Considered Options

1. **Signature algorithm.** ECDSA P-256; Ed25519; RSA-2048; RSA-4096.
2. **Host key storage.** macOS Secure Enclave with Keychain fallback; Keychain plain item; file-on-disk encrypted with a derived password.
3. **iOS device-fingerprint key storage.** iOS Secure Enclave; Keychain plain item.
4. **Token lifetime.** No expiry with explicit Revoke; 90-day sliding refresh; 90-day fixed expiry; `tokenId`-based revocation list.
5. **Tailnet hostname in QR.** MagicDNS FQDN only; CGNAT IPv4 only; both fields with FQDN primary and IPv4 fallback.
6. **Nonce model.** Single-use nonce with 90-second TTL persisted by host until expiry; monotonic counter with tolerance window; no replay protection.

## Decision Outcome

**1. Signature algorithm: ECDSA P-256.** Apple's Secure Enclave on both Apple Silicon Macs and recent iPhones supports P-256 and only P-256 for asymmetric keys. Choosing P-256 is the prerequisite for the Secure Enclave story (decision 2). Ed25519 is the modern default for greenfield protocols, but it cannot be stored in the Secure Enclave on Apple platforms, and the gap between Ed25519 and P-256 at signature size (64 bytes vs 64 bytes uncompressed for both at this scale), verification speed, and security margin is not meaningful for a system that signs at most once per pairing approval and verifies at most once per WebRTC peer connection. RSA is rejected on size and speed.

**2. Host key storage: macOS Secure Enclave with Keychain plain-item fallback.** The host's signing key is generated inside the Secure Enclave on first run via `SecureEnclave.P256.Signing.PrivateKey.init(accessControl:)`. Private bytes never leave the SE. If Secure Enclave is unavailable (Intel Macs without the T2, or virtualized environments), fall back to a Keychain plain item flagged `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. The fallback path is not in the v0 target hardware (the developer's Mac is Apple Silicon) but the code path exists because the cost of writing it is two `if let` branches and the alternative is an unrecoverable startup error on the wrong machine.

**3. iOS device-fingerprint key storage: iOS Secure Enclave.** Same primitive on the client. `SecureEnclave.P256.Signing.PrivateKey` generated on first pairing scan, signed over by the iOS app to prove the device-fingerprint binding when presenting the `SessionToken`. No Keychain-plain fallback on iOS for v0; if the iPhone lacks a Secure Enclave (iPhone 5s or earlier, not in scope), the app surfaces "device not supported" and exits.

**4. Token lifetime: no expiry, explicit Revoke only.** `SessionToken` carries `issuedAt` for informational purposes; nothing enforces it. The host's paired-device allowlist (the set of device fingerprints with Revoke not pressed) is the single source of trust. Revoking via the host popover removes the device fingerprint from the allowlist; the next connection attempt with that token fails signature-fingerprint cross-check and returns a `revoked` error, on which the iOS app clears its Keychain entry. Sliding-refresh and fixed-expiry token schemes are rejected because they add a refresh state machine to defend against a threat (lost phone, forgotten revoke) that the user can mitigate in one tap on the host. v1 may add expiry if multiple devices change the threat model.

**5. Tailnet hostname in QR: both MagicDNS FQDN and CGNAT IPv4, with FQDN primary.** `PairingPayload` carries both `tailnetFQDN` and `tailnetIPv4`. The iOS client tries the FQDN first; if DNS resolution fails (MagicDNS off on the tailnet, or temporarily unreachable), it falls back to the IPv4 literal. Two-field payload because MagicDNS, while on by default on the Tailscale iOS client, is not contractually guaranteed by Apple or Tailscale and the failure mode of MagicDNS-off is debuggable by a user who can read "couldn't resolve `host.tailnet.ts.net`" but not by a user who scanned a QR with a single field that does not work. The CGNAT IPv4 is stable per-device unless the user recreates the device in the Tailscale admin console.

**6. Nonce model: single-use nonce with 90-second TTL, persisted by host until expiry.** `PairingPayload.oneTimeNonce` is 32 random bytes generated when the host opens the Pair popover. The host maintains an in-memory map of `{nonce -> issuedAt}` and rejects any pairing attempt whose nonce is unknown, expired, or already used. 90 seconds is the window between "user opens Pair popover" and "user scans QR with iPhone"; longer windows expand the screenshot-replay risk, shorter windows risk the user fumbling. The map is cleared on host restart; pairing across a restart requires reopening the popover, which is the right behavior because in-flight pairings were not observed by the host post-restart anyway.

### Refined wire shapes

`PairingPayload` and `SessionToken` from `SPEC.md` are refined as follows. `SPEC.md` is updated to match in the same change as this ADR.

```
PairingPayload {
  hostFingerprint    // SHA-256 over the host's P-256 public key (DER), hex-encoded, 64 chars
  hostPublicKey      // host P-256 public key, raw uncompressed, 65 bytes
  tailnetFQDN        // MagicDNS FQDN, may be empty string if MagicDNS off
  tailnetIPv4        // CGNAT 100.x.y.z literal, always present
  oneTimeNonce       // 32 random bytes
  expiresAt          // unix seconds, issuedAt + 90
}

SessionToken {
  hostFingerprint    // links the token to a specific host identity
  deviceFingerprint  // SHA-256 over the iOS device's P-256 public key
  issuedAt           // unix seconds, informational only
  signature          // ECDSA P-256 signature over canonical encoding of
                     // (hostFingerprint || deviceFingerprint || issuedAt)
}
```

QR encoding: `PairingPayload` is serialized to compact JSON with single-letter keys (`h`, `k`, `d`, `i`, `n`, `e` for `PairingPayload`; `h`, `d`, `i`, `s` for `SessionToken`) to reduce payload size. The compact JSON is base64url-encoded and embedded in a `agentdesk://pair?p=<base64url>` URL. Total QR payload target: under 500 bytes. The irreducible cost of the required fields plus base64url envelope is ~410 bytes at typical FQDN lengths; the budget is set to 500 to leave headroom for FQDN variation while keeping the QR scannable at arm's length on QR version 12 with low error correction. An earlier draft of this ADR targeted 250 bytes; that number was unmeasured. Bumping the budget rather than dropping required fields preserves the symmetric-key, signature-verifiable trust model intact.

### Consequences

- Good, because the host's signing identity is non-exfiltrable from the Mac short of physical Secure Enclave attack. The signature on a `SessionToken` cannot be forged by malware that compromises the host process.
- Good, because the symmetric SE-on-both-ends story keeps the protocol's mental model small: every signature is P-256, every key is hardware-backed, every fingerprint is SHA-256 over the same public-key format.
- Good, because no token refresh state machine. The host's allowlist is the trust record; nothing else needs to stay in sync.
- Bad, because the host's Secure Enclave key cannot be backed up. If the Mac dies or is wiped, the host's identity changes and the iPhone must re-pair. Acceptable for v0 (one user, infrequent event). v1 may add an explicit "rotate host key" flow if the failure becomes routine.
- Bad, because no token expiry means a lost iPhone retains access until the user manually presses Revoke on the host. Mitigated by the single-tap revoke in the SPEC's Pairing interface; the threat model says the user notices a lost phone faster than 90 days anyway.
- Neutral, because the two-field hostname format costs ~30 bytes in the QR payload. Below the 250-byte target.

### Confirmation

The decision is being followed if all of the following hold during code review:

- The host's `Pairing.mintPairingPayload()` calls `SecureEnclave.P256.Signing.PrivateKey` on first run, with a Keychain-plain fallback only when `SecureEnclave.isAvailable` is false.
- No code path computes, stores, or compares `SessionToken.expiresAt`. The field does not exist on the type.
- `PairingPayload` carries both `tailnetFQDN` and `tailnetIPv4`. The iOS `PairingClient` calls FQDN resolution first and falls back to IPv4 on failure within a single connect-retry window.
- The host maintains an in-memory nonce map with 90-second TTL. Nonces are removed on first successful use and on expiry. No persisted nonce state across host restarts.
- The QR payload is a `agentdesk://pair?p=<base64url>` URL whose payload deserializes to the schema above.
- `SessionToken.signature` is verified with ECDSA P-256 against `hostPublicKey` recovered from the allowlist entry matching `hostFingerprint`. No Ed25519 or RSA verification code exists.

Any change to the signature algorithm, the key storage location, the token lifetime model, or the nonce protocol requires an ADR that supersedes this one.

## Pros and Cons of the Options

Only the signature algorithm and token lifetime decisions were close enough to earn this section.

### Signature algorithm: P-256 versus Ed25519

- P-256, good: only choice compatible with Apple Secure Enclave on macOS and iOS. Mature, ubiquitous, no parameter to misconfigure once the curve is fixed. CryptoKit gives a clean `P256.Signing` surface.
- P-256, bad: ECDSA signature generation involves a per-signature random scalar; bad RNG causes catastrophic key recovery (PlayStation 3 incident). Mitigated because we never roll our own RNG; the SE generates the nonce.
- Ed25519, good: modern default, deterministic signatures, no nonce-reuse class of failures, smaller cognitive footprint.
- Ed25519, bad: cannot be Secure Enclave-backed on Apple platforms. Choosing it forces the host's key into a Keychain plain item, which gives up the "private bytes never leave hardware" property. For a single-device-pair v0, the SE-backed property is worth more than the Ed25519 ergonomics.

### Token lifetime: no expiry versus sliding refresh

- No expiry, good: zero refresh state. Single source of trust is the allowlist. Simple to reason about: a token is valid iff its signature verifies and its device fingerprint is on the allowlist.
- No expiry, bad: a lost iPhone keeps access until the user revokes. v0 user is the device's owner; the threat window is bounded by user attention. Acceptable.
- Sliding refresh, good: damage cap if revoke is forgotten. Matches industry patterns for session-cookie auth.
- Sliding refresh, bad: refresh logic on both sides. Refresh during a connection or out of band? Clock drift handling? Refresh failure recovery? Cheap problems each, but the cumulative cost is a state machine that doesn't pay rent for the single-device case. Deferred to v1 if multi-device acceptance reopens the threat model.

## Links

- ADR-0001: locked the overall stack including "QR + Keychain pairing" at mechanism level.
- `SPEC.md`: `PairingPayload`, `SessionToken`, `Pairing` interface; updated in the same change as this ADR.
- `PRD.md`: pairing user surface (user stories 8, 9, 10, 11 in issue #1).
- GitHub issue #3 (S1): the slice this ADR is gating.
- Apple CryptoKit `SecureEnclave.P256.Signing.PrivateKey`: https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing/privatekey (no date verifiable from URL; documented since iOS 13 / macOS 10.15).
