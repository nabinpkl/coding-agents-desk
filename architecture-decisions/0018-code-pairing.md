---
status: accepted
date: 2026-06-21
---

# Locator-code pairing over the tailnet

## Context and Problem Statement

A TestFlight or otherwise remote iPhone is not launched by the Mac, so it cannot receive the `AGENTDESK_LAUNCH_URL` environment URL, and scanning a QR requires the two devices to be physically together. An earlier iCloud Documents handoff solved the remote case but required enabling an iCloud capability for both bundle IDs in the Apple Developer account plus provisioning refresh, which was judged not worth the friction and was reverted. This decision adds a remote pairing path that needs no Apple capability. It touches `Pairing`, `PairingSignalingServer`, `AppDelegate`/`PopoverViewController` on the host, and `PairingClient`/`PairingViewController` on the client, plus a shared `LocatorCode` codec.

## Decision Drivers

- Remote first pairing with no QR and no Mac-side launch of the client.
- No new Apple capability or entitlement, and no new operated service.
- The existing signed `PairingPayload` (ADR-0002) plus host approval stay the trust anchor; no second pairing protocol.
- The transferred secret must be short enough to type by hand.

## Considered Options

- **Option A**: A short locator code carrying the host's tailnet IPv4 plus a one-time fetch token; the client connects to that IP over the existing tailnet TLS signaling server and pulls the signed payload.
- **Option B**: A rendezvous relay the host uploads to, keyed by a 6-char code the client fetches.
- **Option C**: Type the whole payload as a long offline code.

## Decision Outcome

Chose **Option A**. Option B was rejected because it introduces a new operated public service and routes pairing material through a third party. Option C was rejected because the payload (host key, nonce, address) is ~250+ bytes, far too long to type. Option A reuses the host's existing WebSocket-TLS signaling server (a new `payload-fetch` first frame), adds nothing operated, and works fully remote because Tailscale authenticates each peer by its `100.x` IP at the network layer, so connecting to the locator IP reaches exactly the intended Mac with no inter-peer MITM.

Locked parameters:

- **Locator code**: 22 bits of tailnet IPv4 host part (Tailscale CGNAT is `100.64.0.0/10`, so the top 10 bits are fixed) plus a 30-bit fetch token = 52 bits, encoded as 11 Crockford base32 symbols plus 1 Crockford check symbol, grouped `XXXX-XXXX-XXXX` (12 chars). Crockford's alphabet omits I, L, O, U; decoding normalizes case and maps I/L to 1 and O to 0. The codec is duplicated per target (`host/.../LocatorCode.swift`, `client/.../LocatorCode.swift`) and kept byte-identical, with a fixed-string parity test in each suite.
- **Fetch token**: minted from `SecRandomCopyBytes`, retained on the host keyed by the token alongside the signed payload, single-use, default 300s TTL (`AGENTDESK_FETCH_TOKEN_TTL_SECONDS`), and rate-limited to a default 10 attempts/minute (`AGENTDESK_FETCH_RATE_PER_MIN`).
- **Transport**: the client opens `wss://<tailnet-ipv4>:<signalingPort>/pair`, sends `PairingPayloadFetchRequest`, receives `PairingPayloadFetchResponse`, closes, then runs the unchanged `performHandshake`.
- Host approval remains required unless `AGENTDESK_AUTO_APPROVE=1`. QR and SIGUSR1 pairing are preserved unchanged; the locator code is additive.

## Security model

The fetch token gates retrieval of the signed payload only; it is not a credential and grants no access by itself. The trust anchors are unchanged: Tailscale authenticates the peer at L3 (the locator IP reaches exactly that Mac, encrypted), the client verifies the host's signature over the payload before persisting any token, and manual host approval still gates session-token issuance. Replay is bounded by the one-use token and short TTL, plus the embedded `oneTimeNonce`'s own 90s one-use TTL for the handshake; both must be live for a full pair. The per-minute rate limit bounds online guessing of the 30-bit token.

### Consequences

- Good, because a remote/TestFlight client pairs by typing a 12-character code, with no Apple capability, no relay, and no Mac-side launch.
- Good, because the host's existing signed-payload + approval flow is reused verbatim; the new surface is one codec, one signaling frame, and one token store.
- Bad, because in production the client dials a CGNAT IP literal whose FQDN-issued TLS cert fails hostname validation; a narrowly scoped `URLSessionDelegate` trusts the server cert only for `100.64.0.0/10` hosts, leaning on the payload signature as the real anchor. FQDN dials keep default validation. This path is masked by the DEBUG permissive delegate, so it is validated on a physical device.
- Neutral, because the locator code is 12 characters rather than 6; the address bits are irreducible without a directory service and shrinking the token weakens guessing resistance.

### Confirmation

`LocatorCodeTests` (both targets) assert round-trip across CGNAT addresses, `ipOutsideCGNAT` rejection, length/checksum/invalid-character rejection, case and ambiguous-character normalization, and a fixed-input parity string. `PairingTests` assert the fetch token retains the payload and is consumed once, expires after its TTL, and trips the rate limit. The routing test classifies a `payload-fetch` frame. `PairingClientTests` assert locator decode and malformed rejection plus the parity string. The full fetch-to-handshake round trip and the production CGNAT TLS path are validated by physical TestFlight acceptance (TASKS R53.8).

## Known residual risks (accepted)

- A malicious tailnet peer with socket access could attempt token guessing; mitigated by 30-bit entropy, short TTL, one-use, and rate limiting, with host approval as the backstop.
- The host writes the pairing URL and locator code to cleartext dev files (`.last-pair-url`, `.last-locator-code`) and logs the URL for the Justfile recipes; this is the pre-existing local-dev posture.
- If a Mac's discovered tailnet IPv4 is ever outside `100.64.0.0/10`, `LocatorCode.formatted()` throws and the host falls back to showing only the QR rather than failing pairing.

## Links

- ADR-0002 pairing crypto (the signed payload reused as the envelope)
- ADR-0003 session establishment and the application-layer trust model
- Crockford base32 specification (`https://www.crockford.com/base32.html`, accessed 2026-06-21)
