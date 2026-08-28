---
status: accepted
date: 2026-08-28
---

# Install the local runtime outside disposable build output

## Context and Problem Statement

Deleting the repository's large `.build` tree removed the desktop helper, the running host's
on-disk app bundle, and the live panel server's TLS/token files. WebRTC offers then failed with
`tile-encoder-missing`, while the viewer only appeared to reconnect. Build cache cleanup must not
remove installed runtime dependencies. This changes deployment paths, not the TypeScript ownership
or native capabilities established in ADR-0109 and ADR-0110.

## Decision Drivers

- Build outputs can be discarded independently of the installed host and desktop helper.
- Helper changes remain possible without rebuilding, reinstalling, or relaunching either app.
- Stable/dev hosts retain distinct bundle identities, state, sockets, and installed paths.
- Failed compilation or validation leaves the previous installed artifact intact.

## Considered Options

- **Keep executing from `.build`** and forbid cleanup: rejected because caches become undeletable
  runtime state, the cause of this outage.
- **Bundle every helper update into the app**: rejected because it makes standalone capability
  changes require an app deployment, contrary to the established fast iteration boundary.
- **Install independent copies into a durable runtime home**: selected.

## Decision Outcome

`tools/runtime-paths.mjs` is the shared resolver for the Node deployment recipes and both live and
compiled Bun sidecars. Its default root is `~/Library/Application Support/AgentDeskRuntime`, with
an absolute `AGENTDESK_RUNTIME_ROOT` override. It contains:

- `hosts/<bundle-id>/AgentDeskHost.app`: one complete signed app per host variant, shared by that
  variant's Debug and Release launches.
- `bin/grid-encoder`: the shared standalone desktop capability helper. An explicit absolute
  `AGENT_FEED_GRID_ENCODER_PATH` can replace this location.
- `agent-panel/tls` and `agent-panel/control-token`: the live server's certificate/key and `0600`
  bearer token. The separate development park sidecar uses `park-dev/control-token`.

Compilation still writes disposable candidates into `.build`. `just grid-encoder-install` builds
a candidate and atomically copies it into the runtime; ordinary build/test gates do not install.
Changed helper content advances its mtime generation, while an identical install preserves it.
Host launch recipes validate the built bundle, preserve PTY processes while stopping the selected
host, install an independent signed copy, and launch that copy. All host discovery uses the exact
installed executable. Bundle links escaping the app are rejected so a copied app cannot secretly
depend on its original build directory. Installation refuses to replace a running destination app.

There is no build-directory lookup fallback. A missing helper names the installation command. A
running panel server whose token file is missing must be stopped explicitly before a new host
launch; minting a new token behind that server would break authentication.

### Consequences

- Good: removing build output no longer removes installed binaries or live server credentials.
- Good: source-mode TypeScript iteration, pairing, persistent user state and PTY sockets do not move.
- Bad: builds and installed artifacts occupy separate space. Only the small deployable set is copied,
  not DerivedData, test results, caches, or archives.
- Bad: the helper and development credentials remain writable by the same OS user. Relocation is
  durability, not a new security boundary; ADR-0110's same-user authority cost remains.
- Neutral: first use of the new host path needs an explicit host deployment checkpoint and live
  Screen Recording/Accessibility verification. This decision does not authorize client installation,
  reset permissions, or claim that an already-deleted host bundle can recover without being restored.

### Confirmation

Tests remove isolated build trees and execute the installed helper and signed test app, verify
signature/resource preservation, reject external bundle links and invalid candidates, preserve
helper generations, and refuse replacement of a running app. A compiled Bun probe confirms that
runtime lookup does not depend on source paths. Dry-run recipe and environment tests cover both
host variants and durable discovery without launching either daily-driver app.
