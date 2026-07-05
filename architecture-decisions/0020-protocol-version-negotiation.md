---
status: proposed
date: 2026-06-22
---

# Wire protocol version negotiated at the session handshake

## Context and Problem Statement

The host (macOS, local) and client (iOS, TestFlight) are separate apps on separate release cadences, and their marketing versions are now independent (AGENTS.md "Versioning"). Independent app versions only make sense if there is a real compatibility contract between them, and matching version numbers is not one. Today the two are always co-built from this tree, so a future host change that alters the wire shapes could break an older client silently. This touches the session handshake (`SessionInit`/`SessionChallenge`, `SessionAuthenticator`, `SessionDialer`) and `SessionRejectionReason`.

## Decision Drivers

- Host and client must be able to ship independently without an implicit "rebuild both" rule.
- A breaking wire change must fail loudly with a clear "update the older app", not corrupt a session.
- Backward-compatible changes (new optional fields) must not force a lockstep update.
- Keep the existing signed challenge-response (ADR-0003) intact.

## Considered Options

- **Option A (chosen)**: a monotonic integer protocol version exchanged at the session handshake; each side rejects a peer below its minimum-compatible version. Bumped only on breaking wire changes.
- **Option B**: gate compatibility on the marketing version. Rejected: the marketing version tracks releases, not wire compatibility, and the two apps version independently.
- **Option C**: do nothing until the first breaking change. Rejected: the guard must exist before the apps can diverge, or an old client fails in confusing ways.

## Decision Outcome

Chose **Option A**. Each build carries `Config.protocolVersion` (current) and `Config.minCompatibleProtocolVersion` (oldest peer it still speaks to), both starting at 1. The client sends `protocolVersion` in `SessionInit`; the host rejects with `incompatibleProtocol` if it is below the host's minimum, otherwise returns its own `protocolVersion` in `SessionChallenge`; the client applies the symmetric check and rejects a host that is too old. The version bumps **only** on a breaking wire change, independent of marketing versions; backward-compatible additions (decode-tolerant optional fields, as both new fields are) do not bump it. Both fields decode-tolerantly default to 1 so the change is inert against existing peers. The signed challenge-response is unchanged; the protocol check runs before/around it and never weakens it. Current v0 is protocol `4` with minimum `4`; protocol `4` breaks protocol `3` by replacing the text-input focus `editable` bool with the `editability` enum.

### Consequences

- Good, because host and client can now ship on independent cadences with a real, explicit compatibility boundary.
- Good, because a true incompatibility surfaces as a clear "update required" instead of a malformed-frame failure.
- Neutral, because at version 1 with min 1 the path is dormant; it exists for the first breaking change.
- Bad, because it adds a small always-present field and a check to the hot session path; cost is negligible.

### Confirmation

`SessionAuthenticatorTests` cover a client below the host minimum being rejected with `incompatibleProtocol` and the challenge advertising the host version; the existing handshake tests confirm the default (v1) path is unaffected. When the version is first bumped, the bump and its `minCompatibleProtocolVersion` policy are recorded here.

## Links

- ADR-0003 Session establishment (the handshake this extends)
- ADR-0019 Mac-initiated tailnet pairing
- AGENTS.md "Versioning"
