# Agent Feed Mobile Surface Implementation Plan

> **For agentic workers:** Implement task-by-task. Each task names files, the interface contract it must honor, the tests to write (by assertion, not transcribed code), the verification command, and a done-when. Write the actual code against the real files at execution time; do not expect verbatim code here. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only agent surface in the AgentDesk iPhone client that renders combined Claude + Codex agent threads, fed by ATC's normalization on the Mac host over the existing QUIC session input lane, rendered by reusing ATC's React components in a local WKWebView.

**Architecture:** ATC's engine runs as a Bun sidecar under the Swift host and normalizes transcripts (SSOT unchanged). The host bridges that output onto the existing authenticated QUIC input lane as new `t`-tagged message types. The client hosts a native container that mounts a WKWebView running ATC's React components, fed through a Swift-to-JS bridge. Spec: `docs/superpowers/specs/2026-06-30-agent-feed-mobile-surface-design.md`.

**Tech Stack:** Swift/AppKit (host), Swift/UIKit + WKWebView (client), React 19 + zustand (ATC dashboard, reused), Bun + TypeScript (ATC engine sidecar), QUIC session input lane (existing).

## Global Constraints

- Read-only. No write path back into any agent session ships here. No worker mutation, reveal, or vscode-open paths on the phone.
- Wire shapes are load-bearing. New input-lane message types are additive; renaming any wire field requires an ADR (per `SPEC.md`). Protocol stays version 3; these types are additive, not a version bump.
- Reuse existing dependencies. `zustand` is already in the dashboard; the injected store uses it. Any new library passes the `AGENTS.md` dependency bar (latest release, 100+ stars, real human maintenance) before it is added.
- No em-dashes in docs, commits, or prose. No emoji.
- Device installs, launches, rebuilds, and reinstalls are a checkpoint: prepare and state the command, then stop for an explicit go-ahead (per `AGENTS.md`). Phases 1 to 3 need no device. Phase 4 does.
- Auto-commit each green logical unit and push (per `AGENTS.md`). A unit is green when its phase's verification command passes.
- Verification commands: ATC dashboard `bun test` and `bun run build`; host `just check`; client `just sim-test`.

---

## Phase 1: ATC data-source extraction (ATC repo, no agent-desk dependency)

Goal: funnel the dashboard's data hooks behind an injectable `AgentDataSource` so the same components can later be fed by the QUIC bridge instead of HTTP/SSE. Desktop dashboard stays behavior-identical on the HTTP path. Repo: the ATC repository's `dashboard/`.

This phase ships working software on its own: the dashboard keeps working, now with a swappable data source.

### Task 1.1: Pure paging math

**Files:**
- Create: `src/features/canvas/dataSource/paging.ts`
- Test: `src/features/canvas/dataSource/paging.test.ts`
- Modify: `package.json` (add `"test": "bun test"`)

**Interface (produces):**
- `PAGE_SIZE: number` (100, lifted from `useSessionEventsStream.ts:28`).
- `seedRange(total, pageSize?) -> { offset, limit }` (last-page window; current logic at `useSessionEventsStream.ts:67-68`).
- `olderRange(currentStart, pageSize?) -> { targetStart, limit }` (backward page; current logic at `useSessionEventsStream.ts:115-116`).

- [ ] Write tests asserting: `seedRange(40)` is full window from 0; `seedRange(250)` caps to the last 100; `seedRange(0)` yields a zero-limit page; `olderRange(150)` steps back by 100; `olderRange(40)` clamps `targetStart` to 0. Run `bun test src/features/canvas/dataSource/paging.test.ts`, see it fail (module missing).
- [ ] Implement the two pure functions to satisfy the asserts. Re-run, see green.
- [ ] Commit (`feat: extract session paging math as pure functions`).

**Done when:** `bun test` green for the paging suite.

### Task 1.2: AgentDataSource interface + HttpDataSource

**Files:**
- Create: `src/features/canvas/dataSource/types.ts`
- Create: `src/features/canvas/dataSource/HttpDataSource.ts`

**Interface (produces):** `AgentDataSource` with exactly the three operations the two hooks need, so the hooks consume nothing else:
- `fetchEventsPage(sessionId, offset, limit): Promise<{ events: ActivityEvent[]; total: number }>` (throws on non-ok).
- `subscribeSessionEvents(sessionId, after, { onEvent, onOpen?, onError? }): () => void`.
- `subscribeSessions({ onSessions, onLink }): () => void`.

`ActivityEvent`/`ActivityBlock` are imported type-only from `../useSessionEventsStream` (no runtime cycle); `HarnessSession`/`LinkState` type-only from `../types`. `HttpDataSource implements AgentDataSource` by lifting the existing `fetch`/`EventSource` bodies verbatim from `useSessionEventsStream.ts:58-97` and `sessionsStream.ts:18-42`, reading the base URL from `@/lib/engine`.

**Consumes:** Task 1.1 is not consumed here (the hooks compute ranges); the data source only does IO.

- [ ] Define `types.ts`. No test (pure type module; validated by `bun run build`).
- [ ] Implement `HttpDataSource` by moving the IO out of the two hooks unchanged. This is a behavior-preserving extraction; correctness is gated by Task 1.4/1.5 build + the dashboard smoke, not a unit test (no fetch/EventSource mock harness exists and adding one is out of scope).
- [ ] Commit (`refactor: add AgentDataSource interface and HttpDataSource`).

**Done when:** `bun run build` typechecks the new modules.

### Task 1.3: DataSourceProvider context

**Files:**
- Create: `src/features/canvas/dataSource/context.tsx`

**Interface (produces):**
- `DataSourceProvider({ children, source? })` (client component; defaults `source` to a memoized `new HttpDataSource()`).
- `useDataSource(): AgentDataSource` (throws if used outside the provider).

- [ ] Implement the React context + provider + hook.
- [ ] Commit (`feat: add DataSourceProvider context`).

**Done when:** `bun run build` typechecks.

### Task 1.4: Refactor useSessionEventsStream onto the data source

**Files:**
- Modify: `src/features/canvas/useSessionEventsStream.ts`

**Consumes:** `useDataSource()` (1.3), `seedRange`/`olderRange`/`PAGE_SIZE` (1.1), `AgentDataSource` (1.2).

Replace the direct `fetch`/`EventSource` calls with `ds.fetchEventsPage` and `ds.subscribeSessionEvents`, and the inline range arithmetic with `seedRange`/`olderRange`. Keep `State`, the return shape (`{ events, total, windowStart, loadOlder, loading, error, connected }`), and the dedupe-by-index merge behavior identical. Effect deps become `[sessionId, ds]`. The `ActivityBlock`/`ActivityEvent` exports stay in this file (other modules import them).

- [ ] Make the swap. The probe-then-seed flow stays: `fetchEventsPage(sessionId, 0, 1)` for `total`, then `seedRange(total)` for the page, then `subscribeSessionEvents(sessionId, total, ...)`.
- [ ] Wrap the dashboard tree: in `src/app/layout.tsx`, render `<DataSourceProvider>` inside `<ThemeProvider>` around `{children}`.
- [ ] Verify: `bun run build` green, then `just dev` (from repo root) and confirm a session tile's `ActivityFeed` still seeds, live-appends, and pages older. This manual dashboard smoke is the behavioral gate for the extraction.
- [ ] Commit (`refactor: drive session events hook through injectable data source`).

**Done when:** dashboard renders threads identically to before.

### Task 1.5: Refactor useSessionsStream onto the data source

**Files:**
- Modify: `src/features/canvas/sessionsStream.ts`

**Consumes:** `useDataSource()`.

Replace the `EventSource(/api/sessions/stream)` body in `useSessionsStream` (`sessionsStream.ts:18-42`) with `ds.subscribeSessions({ onSessions, onLink })`. Keep `{ sessions, loaded, link }` return shape; set `loaded` true on first `onSessions`. Leave `revealInFinder`/`openInVscode` (write actions) untouched in this repo; they are simply not wired into the iOS bundle later.

- [ ] Make the swap. Effect deps `[ds]`.
- [ ] Verify: `bun run build` green; `just dev` shows the session rail populating and the link badge transitioning live/reloading/offline as before.
- [ ] Commit (`refactor: drive sessions list hook through injectable data source`).

**Done when:** session rail and link state behave identically.

**Phase 1 ships:** dashboard works as before, data hooks now swappable. This is the prerequisite the iOS `BridgeDataSource` (Phase 3) plugs into.

---

## Phase 2: Wire contract + host bridge + Bun sidecar (agent-desk host)

Goal: the host produces agent-feed lane messages from sidecar data. Testable via round-trip codec tests and a fake-lane bridge test before any client renders. Repo: `~/projects/agent-desk`.

### Task 2.1: Wire types in both SharedTypes copies (contract seam)

**Files:**
- Modify: `host/AgentDeskHost/SharedTypes.swift`
- Modify: `client/AgentDeskClient/SharedTypes.swift`
- Test: host and client SharedTypes codec test files (mirror the existing diagnostics/`DesktopStatePush` test pattern; find them alongside the current input-lane type tests).

**Interface (produces):** input-lane message types, `t`-tagged per the spec, added to both copies identically (the two-copy drift is the main risk this task controls):
- Client to host: `AgentProjectsSubscribe` (`agent-projects-sub`), `AgentThreadSubscribe { projectPath, source?, sessionId? }` (`agent-thread-sub`), `AgentThreadLoadOlder { sessionId, beforeIndex, limit }` (`agent-thread-older`), `AgentThreadUnsubscribe { sessionId }` (`agent-thread-unsub`).
- Host to client: `AgentProjectsPush { projects: [ProjectDigest] }` (`agent-projects`), `AgentThreadChunk { sessionId, events: [ActivityEvent], windowStart, total, isLive }` (`agent-thread-chunk`), `AgentThreadError { sessionId, reason }` (`agent-thread-error`).
- `ActivityEvent`/`ActivityBlock` mirror the TS shapes from Phase 1 (`index, ts, type`; `kind, text?, tool?, summary?, input?, preview?, callId?`). `ProjectDigest` mirrors ATC's `/api/projects/digest` row (project path, intent/title, source counts, primary + recent sessions, git state, liveness); model the subset the surface renders, not every field.

- [ ] Write round-trip codec tests on both sides asserting each new type encodes and decodes through the input-lane envelope, and that an unknown `t` is ignored (forward-compat). See them fail.
- [ ] Add the types and their encode/decode arms to both copies. Re-run.
- [ ] Verify: `just check` (host) and `just sim-test` (client) green.
- [ ] Commit (`feat: add agent-feed input-lane wire types`).

**Done when:** both codec suites green; the two SharedTypes copies are byte-identical for these types.

### Task 2.2: Bun sidecar packaging and supervision

**Files:**
- Create: `host/AgentDeskHost/AgentEngineSidecar.swift` (spawn, supervise, restart, teardown a child process; model lifecycle on the existing host process/service ownership).
- Modify: host Xcode project + `Justfile` to bundle the ATC engine build and a Bun runtime as a host resource (new build step; wrap in a recipe).
- Modify: `host/AgentDeskHost/Config.swift` (sidecar binary path, port or stdio choice, all via config, no hardcoded paths).

**Interface (produces):** `AgentEngineSidecar` exposing start/stop and a local subscription handle the bridge consumes (host-internal IPC over stdout or loopback; never exposed to the phone). Decide stdout-NDJSON vs loopback in this task and record it in the ADR.

- [ ] Stand up the sidecar process management with a liveness check; a crash surfaces an error to subscribers and triggers restart.
- [ ] Verify: `just check` green; sidecar starts under the host and answers a project-digest request locally (a host-side smoke, not a device run).
- [ ] Commit (`feat: run ATC engine as a supervised host sidecar`).

**Done when:** host launches the sidecar and reads normalized data locally.

### Task 2.3: AgentFeedBridge on the active session

**Files:**
- Create: `host/AgentDeskHost/AgentFeedBridge.swift`
- Modify: `host/AgentDeskHost/PairingSignalingServer.swift` and/or `host/AgentDeskHost/InputChannelServer.swift` (route the new client-to-host requests; mirror how `ClientDiagnosticsRequester` and the diagnostics request frames are handled on the input lane).
- Modify: `host/AgentDeskHost/AppDelegate.swift` (wire the bridge to the session via `SessionRegistry`, next to the existing `inputLaneReadyHandler` wiring).
- Test: `AgentFeedBridge` test with a fake input-lane transport and a fake sidecar source.

**Interface (consumes):** sidecar subscription (2.2), wire types (2.1), the session registry + input-lane ready handler (existing).
**Interface (produces):** translation: `AgentProjectsSubscribe` to a `AgentProjectsPush`; `AgentThreadSubscribe` to ordered `AgentThreadChunk`s (seed page then live appends, `isLive` distinguishing); `AgentThreadLoadOlder` to one bounded historical chunk; `AgentThreadUnsubscribe` tears down. Re-attach resets subscriptions on session resume.

- [ ] Write the bridge test asserting: a subscribe yields an ordered seed chunk then live chunks; load-older yields one bounded chunk; a sidecar crash yields `AgentThreadError`; lane re-attach re-establishes the subscription. See it fail.
- [ ] Implement the bridge and wire the request routing + `AppDelegate` hookup. Re-run.
- [ ] Verify: `just check` green.
- [ ] Commit (`feat: bridge agent threads onto the session input lane`).

**Done when:** bridge test green; requests produce ordered chunks over a fake lane.

**Phase 2 ships:** host emits correct agent-feed messages on demand, verified without a phone.

---

## Phase 3: Client native container + webview bundle + injected store (agent-desk client)

Goal: the phone renders a real combined thread from host pushes. Repo: `~/projects/agent-desk`, plus the React bundle built from the ATC dashboard components.

### Task 3.1: BridgeDataSource (TS) for the webview

**Files:**
- Create (in the ATC dashboard package, alongside `HttpDataSource`): `src/features/canvas/dataSource/BridgeDataSource.ts` and `BridgeDataSource.test.ts`.
- Create: `src/features/canvas/dataSource/HostBridge.ts` (transport seam).

**Interface (consumes):** `AgentDataSource` (Phase 1).
**Interface (produces):**
- `HostBridge { postToHost(msg): void; onHostMessage(cb): () => void }` with a `WebkitHostBridge` (over `window.webkit.messageHandlers` + a `window`-injected delivery hook) and a `FakeHostBridge` for tests.
- `BridgeDataSource implements AgentDataSource`, constructed with a `HostBridge`. `fetchEventsPage` is satisfied from buffered `AgentThreadChunk`s (or a request/await keyed by `sessionId`); subscribes post `AgentThreadSubscribe`/`AgentThreadLoadOlder`/`AgentThreadUnsubscribe`; inbound chunks drive `onEvent`/`onSessions`. Maps `AgentThreadChunk.isLive` to seed vs live, and `windowStart`/`total` to the same anchors the hook expects.

- [ ] Write `BridgeDataSource.test.ts` with a `FakeHostBridge` asserting: injecting an `AgentProjectsPush` calls `onSessions`; injecting seed then live `AgentThreadChunk`s drives `onEvent` in index order; `loadOlder` posts an `AgentThreadLoadOlder` and applies the returned chunk; an `AgentThreadError` surfaces an error. See it fail.
- [ ] Implement `HostBridge` + `BridgeDataSource`. Re-run via `bun test`.
- [ ] Commit (`feat: add BridgeDataSource for the QUIC-fed webview`).

**Done when:** `bun test` green for the bridge suite; the desktop dashboard is untouched (still on `HttpDataSource`).

### Task 3.2: Webview React bundle + build recipe

**Files:**
- Create: a small webview entry that mounts the reused components (project list, project detail, `ActivityFeed`/`MarkdownView`) inside a `DataSourceProvider` whose `source` is a `BridgeDataSource`.
- Create: a bundler config (Vite or esbuild) producing static `index.html` + JS + CSS.
- Modify: `Justfile` (a recipe building the bundle and copying it into the client app bundle as a resource) and the client Xcode project (treat the bundle as a bundled resource; `xcodebuild` depends on the recipe).

**Interface (consumes):** Phase 1 components + Phase 3.1 `BridgeDataSource`.
**Interface (produces):** a `file://`-loadable static bundle at a known resource path the client reads.

- [ ] Stand up the entry + bundler; confirm the bundle builds and loads in a browser against a `FakeHostBridge` fixture (renders a fixture thread).
- [ ] Add the `just` recipe and wire it into the client build.
- [ ] Decide here whether Milkdown/Crepe stays or is swapped for `marked` + `highlight.js` based on the bundle size you observe; if swapped, the new lib passes the dependency bar. Record the call.
- [ ] Verify: bundle builds; `just check` (or the client build) still green with the resource wired.
- [ ] Commit (`feat: build the agent-feed webview bundle into the client`).

**Done when:** the bundle renders a fixture thread in a browser and is packaged into the client.

### Task 3.3: Native container + WKWebView bridge + surface toggle

**Files:**
- Create: `client/AgentDeskClient/AgentSurfaceController.swift` (hosts the `WKWebView`, owns the JS bridge).
- Modify: `client/AgentDeskClient/InputChannel.swift` (send the new client-to-host requests; deliver the new host-to-client pushes to the surface).
- Modify: `client/AgentDeskClient/PairingViewController.swift` (+ a new `PairingViewController+AgentSurface.swift` extension if it keeps the VC focused) to add the toggle between the control surface (video + trackpad) and the agent surface, and forward session lifecycle.
- Test: an `AgentSurfaceController` bridge test (encode outbound intents, deliver inbound pushes to a fake webview message sink) and an `InputChannel` round-trip for the new types (mirrors existing input-channel tests).

**Interface (consumes):** wire types (2.1), `InputChannel` (existing), the webview bundle (3.2).
**Interface (produces):** outbound, the webview's `postToHost` intents map to `AgentProjectsSubscribe`/`AgentThreadSubscribe`/`AgentThreadLoadOlder`/`AgentThreadUnsubscribe` on the input lane; inbound, `AgentProjectsPush`/`AgentThreadChunk`/`AgentThreadError` are delivered into the webview via `WKScriptMessageHandler` / `evaluateJavaScript`. On background drop the surface suspends; on resume it re-seeds the current thread.

- [ ] Write the bridge + `InputChannel` tests. See them fail.
- [ ] Implement the controller, the `InputChannel` wiring, and the surface toggle. Re-run.
- [ ] Verify: `just sim-test` green; `just check-all` green.
- [ ] Commit (`feat: add native agent surface hosting the QUIC-fed webview`).

**Done when:** sim test renders a fixture thread end-to-end through the bridge; the surface toggle works.

**Phase 3 ships:** the client renders threads from host-shaped messages, verified in the simulator.

---

## Phase 4: Device validation (gated)

Goal: confirm the felt thesis on hardware. Gated on explicit go-ahead per the `AGENTS.md` device checkpoint; do not run any device recipe without it.

### Task 4.1: Real-device combined-thread scroll

- [ ] Prepare (do not run yet) the full path: host rebuild + sidecar, client reinstall, pair, open the agent surface within a live session. State the exact recipe (`just fresh-consoled-run` family) and stop for go-ahead.
- [ ] On go-ahead, run it. Observe: a project's combined Claude + Codex thread renders, scrolls crisply, live-appends as an agent works, and pages older without losing scroll anchor. Capture host (`owned-media`/feed) and attached client logs in the same run.
- [ ] Record the PRD edit and ADR (the scope reopen and the sidecar dependency) if not already landed; reference the ADR from `SPEC.md`.
- [ ] Commit any fixes found, then the docs.

**Done when:** the author can watch agents build a project from the phone by scrolling a crisp combined thread, within a live session.

---

## Self-review

- **Spec coverage:** read-only (Global Constraints + no write tasks); project-first nav (3.2 components + ProjectDigest in 2.1); QUIC input lane only (2.1, 2.3, 3.3); Bun sidecar not Swift port (2.2); React-in-WKWebView reuse (3.2); injectable data source (Phase 1); wire contract (2.1); host wiring via SessionRegistry/inputLaneReadyHandler (2.3); native/web seam and toggle (3.3); error handling, resume re-seed, sidecar-crash error (2.3, 3.3); scope reopen PRD+ADR (4.1, and gate-flagged in the spec); Milkdown weight decision point (3.2); testing across all three layers (per-task). No uncovered spec section.
- **Decomposition:** four phases, three of them shippable and verifiable without a device. Phase 1 is independent of agent-desk entirely.
- **Type consistency:** `AgentDataSource` (fetchEventsPage / subscribeSessionEvents / subscribeSessions) is defined in 1.2 and consumed unchanged in 1.4, 1.5, 3.1. Wire `t`-tags defined in 2.1 are the same strings routed in 2.3 and 3.3. `ActivityEvent`/`ActivityBlock`/`ProjectDigest` shapes are stated once in 2.1 mirroring Phase 1.

## Cross-references

- Spec: `docs/superpowers/specs/2026-06-30-agent-feed-mobile-surface-design.md`
- Wire-shape and ADR rules: `SPEC.md`, `AGENTS.md`
- Reused engine and components: the private ATC repository (`dashboard/src/features/canvas`, `engine/src`)
