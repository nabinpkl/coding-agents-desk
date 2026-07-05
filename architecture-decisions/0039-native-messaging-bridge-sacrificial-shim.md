---
status: proposed
date: 2026-07-01
---

# Bridge Chrome to the host through a sacrificial native-messaging shim

## Context and Problem Statement

The DOM-mirror subsystem (ADR-0038) needs rrweb events to travel from an MV3 Chrome extension to the long-lived `AgentDeskHost`, and input commands back. Chrome's only sanctioned egress from an extension to a native process is Native Messaging, where Chrome **spawns and owns the lifecycle** of the registered host executable (stdio pipe, killed when the port/tab/browser closes, run under Chrome's process tree and environment). Registering `AgentDeskHost.app` itself as the native host would hand Chrome the power to start and kill the host, couple the host's lifetime to a browser window, and run it with the wrong permission/env context — unacceptable for a process that owns Screen Recording TCC, the keychain identity, and the QUIC transport.

## Decision Drivers

- The real host must keep its own lifecycle (launchd/menu-bar), TCC grants, and environment — never owned by Chrome.
- Only our extension may reach the bridge (a native-messaging endpoint into the host is a trust surface).
- Cross-process framing must be correct and bounded (Chrome caps extension→host messages at 1 MB).
- The bridge must survive MV3 service-worker recycles and reconnect cleanly.

## Considered Options

- **Option A**: A thin, stateless `dom-bridge` shim as the native-messaging host; Chrome owns the shim, which forwards stdio ↔ a Unix domain socket to the real host.
- **Option B**: Register `AgentDeskHost.app` directly as the native-messaging host.
- **Option C**: No native messaging — have the extension reach the host over WebSocket/HTTP to a localhost port.

## Decision Outcome

Chose **Option A** because the lifecycle-sovereignty driver eliminates B (Chrome would spawn/kill the real host and run it under Chrome's env), and the trust/robustness drivers eliminate C (a localhost listener is reachable by any page/process on the machine and needs its own auth, whereas native messaging restricts the connectable host to `allowed_origins` = our pinned extension ID). The shim is sacrificial: Chrome may spawn, kill, or multi-instance it freely; it holds no state and only re-frames bytes between the Native Messaging wire (4-byte little-endian length-prefixed JSON, ≤1 MB ext→host) and a Unix domain socket (`Config.domBridgeSocketURL`, mirroring `adSocketURL`). The host's `DomBridgeServer` sees the shim as an ordinary socket client; a shim death is just a client disconnect the host already tolerates. The extension ID is pinned via a fixed manifest `key`, so the native-messaging host manifest's `allowed_origins` stays stable across reloads.

### Consequences

- Good, because the real host is never owned by Chrome — its lifecycle, TCC grants, keychain, and env are unaffected by the browser.
- Good, because only our pinned extension can connect (native-messaging `allowed_origins`), a tighter trust boundary than a localhost port.
- Bad, because it adds a process hop (extension → shim → socket → host) and a manifest-install step per Chrome channel.
- Neutral, because the shim is an extra artifact to build and ship, but it is tiny and stateless.

### Confirmation

`just dom-mirror-bridge-verify` (autonomous, Phase 1) asserts a batch and input round-trip through the shim plus a clean reconnect after the shim is killed, by driving the shim's stdio against a protocol-faithful fake host; the real host-side `DomBridgeServer` is covered by `DomBridgeServerTests` against the same wire contract. Two confirmations are deferred and tracked, not dropped: (1) the live-Chrome native-messaging manifest-search-path confirmation (a real `connectNative` from the real pinned extension) is a hard gate at the START of Phase 2, before any extension code depends on the path; (2) running the real Swift `DomBridgeServer` against the shim in one process (drift check between the two hand-written peers) is a required gate at the START of Phase 3, where `DomBridgeServer` is first constructed for real. The host manifest's `allowed_origins` is the pinned extension ID, so only our extension can connect.

## Links

- ADR-0038 DOM mirror over a dedicated reliable QUIC lane
- Chrome Native Messaging — https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- `Config.domBridgeSocketURL`, `Config.adSocketURL` (the Unix-socket precedent)
