---
status: accepted
date: 2026-08-27
---

# Own the Claude and Codex window composers in TypeScript

## Context and Problem Statement

Fixing one targeting bug cost a Release host build, a relaunch, and a re-attach of every surface, for
a change that was `/bin/ps` argv parsing and a window-title filter. The bug: Claude Desktop owns
several untitled Electron scaffolding windows per instance (measured: eight layer-0 windows, of which
one carried a title), the lowest-windowID one won target selection, the target then read as already on
the active Desktop so no Space move happened, and the real window kept the collapsed accessibility
tree Chromium gives a window on another Space. It surfaced as "composer missing" with nothing naming
the window it had looked in.

Nothing in that file needed to be native, and the same was true of most of the 2,588-line composer
path around it. `HostActionsClient` argued the opposite in writing -- that a composer write "should
cost a Swift compile precisely because of what it can do" -- but that position was already
inconsistent with the codebase: ADR-0109 had put `CGEvent` POSTING, strictly more powerful than
filling a text field, behind the sidecar plus the standalone helper. AGENTS.md's test for keeping
something native is to name the capability TypeScript cannot provide, and composer policy has none.

## Decision Drivers

- A composer behaviour change must cost no app rebuild, reinstall, relaunch, or re-pair.
- The capability bound must move, not disappear: something must still resolve and validate before any
  Accessibility call.
- The two applications resolve their windows differently and must not be forced into one shape.
- A rebuilt helper must actually be the one that serves the next request.

## Considered Options

- **Option A**: Keep the composer native and only move session resolution.
- **Option B**: Move Claude's composer, leave Codex's on the host lane indefinitely.
- **Option C**: Let TypeScript own both composers end to end, keeping only AX, the
  `AXManualAccessibility` latch, and SkyLight in the standalone helper.

## Decision Outcome

Chose **Option C**, and this explicitly reverses the `HostActionsClient` compile-cost boundary.

The sidecar owns the model: session resolution for both applications, the editing lease, the poll,
change-only emission, the renderer-revive gates, the `withWindowHere` sequence, and every failure
code a viewer sees. `grid-encoder --control` owns AX inspection, the latch, the `AXObserver`, Codex's
window-handle capture, and the SkyLight move -- and nothing else: no verb retries, falls back to
another window, or decides what a failure means, and every timeout is passed in from `config.ts`.

The panel reaches all of it through `/api/window/*` over the existing host relay. GET for the stream,
POST for every command, because `AgentFeedRelay.PathPolicy` admits those two verbs alone; that
allow-list is what keeps the relay from being an open local proxy.

Three consequences of the split are worth naming because they are not obvious:

- **The helper is resident, not one-shot.** An `AXObserver` only delivers while its own process runs
  a run loop, and Codex windows on other Spaces are unreachable unless a handle was captured while
  they were here. A per-request helper could read and write a composer but never watch one, which
  would silently downgrade composer sync to polling.
- **Staleness is solved by the build stamp, not by a reload verb.** The binary's mtime is part of the
  encoder pool key and of the control helper's reuse check, so `tools/build-grid-encoder.sh` (6.9s)
  is picked up on the next request. Without it, a running helper would shadow every rebuild for as
  long as one subscriber kept it alive, and the fast loop would be a lie.
- **The helper ends itself on silence.** `bun --watch` reloads the sidecar's module graph in the SAME
  pid, so a helper spawned before a reload is referenced by nothing afterwards and nothing will ever
  kill it. An orphan receives no commands by definition, so a 30s idle timeout is the reaper. (One
  such orphaned `bun` was running on the development machine, ppid 1, alive 1d13h, when this was
  written.)

The desktop audit is read by both the host and the helper, through the same `SkyLightSymbols.swift`
compiled into both. That is two readers of one OS API, not duplicated state: neither caches.

### Consequences

- Good, because composer behaviour, failure wording, poll cadence, and revive policy now change
  through a `bun --watch` reload, and AX behaviour through a 6.9s `swiftc`.
- Good, because the two resolvers are finally separate: Claude's is the process tree, Codex's is the
  app's own state joined to its accessibility tree, and the source travels with every request rather
  than being guessed.
- Good, because ~1,400 lines of Swift left the app bundle and the lane lost eight frame types, three
  wire structs' worth of question shapes, and the sinks that fanned them out.
- Bad, because the helper is an adhoc-signed binary in `.build/` that anything running as this user
  can replace, and it inherits the host's Accessibility and Screen Recording by responsible-process
  attribution. Signing it changes nothing: nothing verifies the signature, and in `sidecar=live` the
  verifier would be the working tree it is verifying. What would change it is spawning from
  `Contents/Resources/` in a bundled build, which is not done here.
- Bad, because Codex's verbs are unverified against the live app. Both Codex windows on the
  development machine were on inactive Spaces, where the app builds no accessibility tree at all, and
  exercising them would have meant moving the user's windows.
- Neutral, because the composer's Space move is now performed by the helper rather than through the
  host's placement authority. ADR-0092 consolidated PLACEMENT of host-owned windows; a foreign app's
  composer move-in and move-back consults no ordinals and no display topology, and the two never
  touch the same windows. `BridgedWindowSpaceMover` remains for `CodexWindowLauncher`, which is
  host-owned placement.

### Confirmation

- Repository search finds no `AgentWindowComposerCoordinator`, `AgentWindowComposerAccess`,
  `CodexWindowComposerAccess`, `agent-window-input-*`, or `agent-window-question-*`.
- `just check` and `just sim-test` green; 524 panel tests and 33 sidecar desktop tests pass,
  including the port of every case from the retired `AgentWindowSessionResolverTests`.
- Measured against the live Claude Desktop through the helper: `ax-latch` succeeded,
  `composer-read` returned the field, `question-read` reported no panel, `window-mover-available`
  true, and `desktop-audit` reported 8 Desktops and 311 windows with `screenRecordingTrusted: true`.
- The bug that started this reproduces in the port's test suite: of one instance's eight layer-0
  windows, the audit shows exactly one titled, single-Space window, and targeting selects it.
- Not yet confirmed: any Codex verb, and the end-to-end panel write. Both need a host run.

## Links

- ADR-0109 Own first-party WebView desktop control in TypeScript (the precedent this follows)
- ADR-0095 Relay the agent feed instead of restating it in Swift
- ADR-0092 Share desktop window placement (amended above)
- ADR-0107 Address a CLI session by its inbox, not its window
- `AGENTS.md` TypeScript-first WebView glue and logging
