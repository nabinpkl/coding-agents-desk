---
status: accepted
date: 2026-06-21
---

# iCloud Documents pairing handoff for TestFlight clients

## Context and Problem Statement

Pairing today requires the Mac to hand the signed `agentdesk://pair` URL to the iPhone through a local channel: QR scan, or a `devicectl`/`simctl` launch that injects `AGENTDESK_LAUNCH_URL`. A TestFlight-installed client is not launched by the Mac and cannot receive that environment URL, so it has no way to obtain a pairing URL without scanning a QR. This decision adds a remote-friendly handoff: the host publishes the same signed URL to a shared iCloud container and the client reads it on an explicit action. It touches `host/AgentDeskHost` (AppDelegate, the new `ICloudPairingPublisher`), `client/AgentDeskClient` (PairingViewController, the new `ICloudPairingReader`), both Xcode targets' entitlements and Info.plists, `Config`, and the `Justfile`.

## Decision Drivers

- A TestFlight client must reach the normal approval/session flow without QR scanning and without the Mac launching it.
- The existing pairing security envelope (signed `PairingPayload`: host key, nonce, expiry; plus host approval) must remain the trust anchor. No second pairing protocol.
- No secret should land in a user-browsable or third-party-readable location.
- iCloud container resolution and document I/O can block for seconds and must not stall the UI.

## Considered Options

- **Option A**: Publish the signed URL as one short-lived document in the app's private iCloud Documents ubiquity container; client reads it on an explicit "Use iCloud Pairing" action.
- **Option B**: Arbitrary iCloud Drive filesystem access (security-scoped bookmark to a user folder).
- **Option C**: A new host-hosted HTTP endpoint the client polls for the pairing URL.

## Decision Outcome

Chose **Option A**. Option B was rejected because it requires user file-picker interaction and exposes the document in the Files app, violating the no-browsable-secret driver. Option C was rejected because it introduces a new operated network surface and a second delivery path with its own trust assumptions, violating the single-envelope driver. Option A reuses `Pairing.mintPairingPayload()` so QR and iCloud handoff share one cryptographic contract, keeps the document app-private, and gates everything behind the existing host approval.

Locked parameters:

- Ubiquity container `iCloud.com.example.agentdesk.AgentDesk`, single stable document `AgentDesk/pairing/latest.json`, overwritten on each publish and deleted after expiry or matching-nonce approval.
- 5 minute TTL on the document; the embedded payload keeps its own 90 second nonce TTL.
- Same Apple ID on Mac and iPhone is assumed.
- Container, path, and TTL are env-overridable through `Config` (`AGENTDESK_ICLOUD_PAIRING_*`).
- Host approval remains required unless `AGENTDESK_AUTO_APPROVE=1`.
- The client reads once per user action; no continuous polling in this slice.

Two implementation conventions were adopted and are recorded here so they are not relitigated:

- The `ICloudPairingDocument` type (and its publisher/reader) is duplicated per target rather than placed in a cross-project shared Xcode group. This matches the repo's existing per-target shared-type pattern and avoids cross-project group wiring; the two copies must stay behaviorally identical, which the host and client tests both assert.
- All container resolution and document I/O runs off the main thread: the host serializes publish, clear, and post-approval cleanup on one `iCloudPairingQueue`; the client reads on a background queue and hops back to main for UI.

### Consequences

- Good, because a TestFlight client pairs without QR or a Mac-side launch, reusing the existing approval/session flow.
- Good, because the document is app-private (`NSUbiquitousContainerIsDocumentScopePublic=false`), so it is not visible in Files or to third-party apps.
- Bad, because the document's `payloadHash` is an unkeyed digest, not a MAC. Any app entitled to the same container could write a document with a self-consistent hash. This is accepted: the real trust anchor is the signed `PairingPayload` plus host approval, both enforced downstream, and the container is shared only between this host and client.
- Neutral, because the `consumed` flag exists in the document contract but the host enforces single-use by deleting the file on approval and by the host-side nonce one-use check in pairing. The flag is a forward-looking document guard, not the live anti-replay mechanism.

### Confirmation

Host `PairingTests` and client `PairingClientTests` assert the document encode/decode round-trip, expiry rejection, schema-version rejection, publisher write with the expected TTL and URL, matching-nonce cleanup, and the reader's deterministic mapping of unavailable/missing/expired/malformed/valid. Full signed `just check` and physical TestFlight acceptance are gated on enabling iCloud Documents for both bundle IDs in the Apple Developer account (see TASKS R52 acceptance rows).

## Known residual risks (accepted, not fixed in this slice)

- The host logs the minted pairing URL at `privacy: .public` and writes it cleartext to `.last-pair-url`. This predates this slice and `.last-pair-url` is load-bearing for `Justfile` device recipes. Hardening it is a separate change.
- `AGENTDESK_ICLOUD_PAIRING_PATH` is not validated against `..` traversal. The risk is operator misconfiguration only, since env vars require local process control; the default value is safe.

## Links

- ADR-0002 pairing crypto (the signed payload reused as the security envelope)
- SPEC pairing and `SessionToken` sections
- Apple: `FileManager.url(forUbiquityContainerIdentifier:)` and iCloud Documents entitlements (developer.apple.com, accessed 2026-06-21)
