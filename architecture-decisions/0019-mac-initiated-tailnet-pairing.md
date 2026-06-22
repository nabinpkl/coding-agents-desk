---
status: proposed
date: 2026-06-22
---

# Mac-initiated tailnet pairing with a host-side device picker

## Context and Problem Statement

Remote and TestFlight clients could not pair without scanning a QR code, and prior remote-pairing attempts both failed on friction: iCloud Documents handoff needed an Apple Developer iCloud capability (reverted), and a typed locator code carrying the host's CGNAT IPv4 plus a fetch token was tedious and failed on-device on the IP-literal-over-TLS path (reverted, see the git history around ADR-0018's removal). The user's direction: lean on the Tailscale mesh that both devices already share, with no typing, no auto-discovery on the phone, and host-side approval like AnyDesk. This touches `Pairing`, `PairingSignalingServer`, `TailnetDiscovery`, `AppDelegate`/`PopoverViewController` on the host and `PairingClient`/`PairingViewController` plus a new `PairingOfferListener` on the client.

## Decision Drivers

- No typing and no QR for the common case; the phone is held one-handed.
- Authorization stays host-side (the human at the Mac decides).
- Reuse the existing, proven client to host handshake and its replay/signature guarantees; do not fork the trust model.
- Avoid the IP-literal-over-TLS trust problem that sank the locator path.

## Considered Options

- **Option A (chosen)**: Mac lists tailnet peers, user picks the iPhone on the Mac, the Mac pushes a signed pairing offer to that device over the tailnet; the iPhone runs the unchanged handshake and the host auto-approves the pre-approved nonce.
- **Option B**: iPhone enumerates the tailnet and dials a chosen Mac. Rejected: the iOS app is sandboxed out of Tailscale's local API and the HTTP API needs a token, so the phone cannot list peers.
- **Option C**: Keep the typed locator code. Rejected: tedious, and it failed on-device on the production CGNAT path.

## Decision Outcome

Chose **Option A** because only the Mac can enumerate the tailnet, and a host-side pick is exactly the AnyDesk-style host authorization the user asked for. The pick is the authorization: the host marks the offer's one-time nonce pre-approved, so when the iPhone dials back with it the signaling server issues the session token directly and skips the approval prompt. The offer is pushed on a dedicated plain-TCP port (41890), not as a new TLS signaling frame, which sidesteps the IP-literal certificate mismatch that knocked out the locator path. Plaintext on that port is acceptable because WireGuard encrypts the peer-to-peer hop, the host public key in the payload is already public, and the nonce is one-use and pre-approval-gated, so a captured offer cannot pair a third device. The offer carries a `PairingPayload`; the iPhone synthesizes its `pairingURL()` locally and feeds the existing `handleIncomingPairingURL` path, so the handshake, signing, and persistence are unchanged.

### Consequences

- Good, because the common case is zero-typing and zero-QR: open the app on the phone, pick it on the Mac, done.
- Good, because the trust model is unchanged: the same signed handshake, the same single nonce-consumption point (`issueApprovedSessionToken`), now reachable by either the prompt path or the pre-approval path.
- Bad, because it requires the iPhone to accept an inbound TCP connection over the Tailscale `utun` interface, which is unproven for a foregrounded sandboxed iOS app (see PRIMARY RISK below).
- Neutral, because a rogue tailnet peer could push an offer; tailnet membership is the trust boundary for the whole product, and the unpaired screen shows the offering host so a wrong host is visible. QR and SIGUSR1 pairing remain as fallbacks.

### PRIMARY RISK

Inbound delivery over `utun` to a foregrounded, sandboxed iOS `NWListener` is unproven; iOS Local Network privacy is built around en0/Bonjour, not VPN tunnels. This must be confirmed on a physical device. If offers never arrive, the fallback keeps the Mac-side pick and pre-approval but inverts the transport: the iPhone dials the Mac (the proven outbound direction) using the host FQDN surfaced by the pick, dropping the listener, the `NSLocalNetworkUsageDescription` key, and own-IP enumeration.

### Confirmation

Host-side unit tests cover peer shaping (`TailnetDiscoveryTests`), the pre-approval lifecycle (`PairingTests`), and the offer-frame codec round-trip. The inbound-over-utun behavior and the end-to-end pick to pair flow are device-only and are verified on a physical iPhone (TestFlight build), with host unified logs and attached client logs captured together.

## Links

- ADR-0002 Pairing crypto (the handshake and nonce this reuses)
- ADR-0003 Session establishment
- SPEC pairing section
