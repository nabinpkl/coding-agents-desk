---
status: accepted
date: 2026-07-01
---

# Host identity is the bundle id; dev and stable hosts are concurrent variants

## Context and Problem Statement

(`<prefix>` is the bundle prefix, `AGENTDESK_BUNDLE_PREFIX` in `.env` since the ids stopped being hardcoded.)

The iOS client already ships as two coexisting installs (`<prefix>.AgentDeskClient` and
`.dev`) that self-namespace at runtime from `Bundle.main.bundleIdentifier`. The macOS host had
no such split: a single hardcoded `"<prefix>.AgentDeskHost"` constant served as the os_log
subsystem, the launchd label, and the dispatch-queue prefix, while the keychain service and the
`~/Library/Application Support/AgentDesk` state root were fixed literals
(`host/AgentDeskHost/Config.swift`). A second host build therefore collided on macOS TCC grants
(Screen Recording, Accessibility, keyed per bundle id), the paired-devices store, the TLS
identity, the unix socket, the signing-key file, the launchd registration, the logs, and the
three loopback ports (signaling 41888, offer 41890, ATC sidecar 7682). There was no way to test a
risky host change without endangering the daily-driver host, the exact protection the client
variant exists to give.

## Decision Drivers

- Protect the working daily-driver host: a broken dev host must not cost the stable host its TCC
  approvals or its paired device.
- Parity with the client's proven variant model (identity from the bundle id, not a runtime flag).
- The two hosts must be able to run concurrently on one Mac (independent capture + input stacks).
- No backward-compat layers or mode toggles (pre-v0 project rule).

## Considered Options

- **Option A**: Derive every per-install anchor from the bundle id; make the variant a build-time
  identity axis; tier-derive the ports and carry the host's signaling port over the pairing offer.
- **Option B**: Runtime mode flag (`--dev`) selecting an alternate namespace and port set.
- **Option C**: A separate Xcode target/scheme for the dev host.

## Decision Outcome

Chose **Option A**. Option B is a trust/data-semantics toggle, which the project rules forbid
("different experiences come from different identity types, not a switch"); it also cannot give
the two installs separate TCC grants, since those are keyed by bundle id + signature, not a flag.
Option C duplicates a target that only differs by three build settings, which the client already
proved unnecessary. Option A reuses the client's mechanism end to end: `Config.bundleIdentifier`
roots the log subsystem, launchd label, dispatch-queue prefix, keychain service, and the
Application Support directory (now the bundle id, Apple-idiomatic); `Config.tier` (derived from the
`.dev` suffix) selects the signaling, offer, and sidecar port defaults so a dev stack on the +100
block never collides with the stable stack; and the host advertises its bound signaling port in
`PairingPayload` so the client dials the advertised value instead of a hardcoded constant. The dev
variant is a build-time override of `PRODUCT_BUNDLE_IDENTIFIER` and `ASSETCATALOG_COMPILER_APPICON_NAME`
in the Justfile, into a separate derived-data dir.

### Consequences

- Good, because a dev host runs concurrently with the stable host with fully separate identity,
  state, permissions, logs, and ports; a broken dev build never touches the daily driver.
- Good, because the crypto identity (P-256 fingerprint, ADR-0002) is orthogonal to the bundle id
  and unaffected: the signing key lives in the keychain, whose service string is unchanged for the
  stable bundle id.
- Bad, because the existing stable host re-initializes its paired-devices store and regenerates its
  TLS cert once (the Application Support directory moved from `AgentDesk` to the bundle id), so the
  daily driver must be re-paired one time. No migration code is written (project norm).
- Neutral, because the dev host is a distinct bundle id and needs its own one-time Screen Recording
  and Accessibility approval in System Settings.

### Confirmation

`just check` and `just check dev` both build+test (each bundle id compiles). With both hosts
running, `lsof -nP -iTCP -sTCP:LISTEN` shows stable on 41888/7682 and dev on 41988/7782, and
`~/Library/Application Support/` holds both bundle-id trees. `log stream --predicate 'subsystem ==
"<prefix>.AgentDeskHost.dev"'` shows only dev-host lines. Pairing the dev client to the dev host
shows the client dialing the advertised 41988, not 41888.

## Links

- ADR-0002 (host crypto identity is the P-256 fingerprint, orthogonal to the bundle id)
- ADR-0019 (Mac-initiated pairing offer, which now carries the signaling port)
- ADR-0020 (wire protocol version negotiated at the session handshake)
