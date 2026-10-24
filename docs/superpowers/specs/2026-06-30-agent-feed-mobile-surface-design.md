# Agent feed mobile surface

> Design spec. A second native surface in the AgentDesk iPhone client that renders Claude and Codex agent threads, read-only, fed by ATC's normalization running on the Mac host over the existing authenticated QUIC session. Status: proposed, pre-implementation.

## Thesis

The durable value of the sibling ATC project (a private sibling repository) turned out to be observability, not its orchestrator/worker model. The orchestrator chases the harness's worker improvements and always lags; the part that earns its keep is seeing both Claude and Codex agent threads, combined per project, in one place.

This arc folds that observability into AgentDesk so the author can watch how agents are building a project from the phone, by natively scrolling crisp agent output, without switching apps. No screen-share of a terminal (mushy, locked to whatever Space the agent sits on); a real text surface decoupled from the Mac's active Space.

The agents run on the Mac. Their durable output is transcript data on the Mac (`~/.claude/projects/*.jsonl`, `~/.codex/state_*.sqlite` plus rollouts), which ATC's engine already reads and normalizes. So this is not an app-embedding problem (iOS forbids nested third-party apps): it is a second surface in the existing iPhone client, fed by the Mac host.

## Scope

In scope (v-next-1):

- A new read-only agent surface in the iPhone client, peer to the existing control surface (video + trackpad).
- Project-first navigation: a list of observed projects, each combining Claude and Codex sessions under one durable project path (ATC ADR-0004), drilling into a project's threads, then scrolling an individual thread.
- Data delivered over the existing authenticated QUIC session input lane. No new transport, no new auth.
- Rendering by reusing ATC's existing React presentation components inside a `WKWebView`, fed through a Swift-to-JS bridge.
- The agent feed is viewable while a remote-control session is live (it rides that session's lane).

Out of scope (explicitly deferred):

- Acting on agents from the phone (reply, approve, nudge, send a follow-up prompt). Read-only first. The data model does not preclude it, but no write path back into a live session ships here.
- Viewing the agent feed without an active screen-share/remote-control session. The feed rides the live session lane for now. A session-independent channel (reusing paired credentials, diagnostics-style) is a later arc.
- Codex worker spawning or any orchestration. This surface observes; it does not drive.
- Multi-machine. Single Mac host, single iPhone, as the rest of AgentDesk.

## Decision record required before merge

This arc reopens AgentDesk's v0 scope deliberately. The PRD's "What v0 is not" currently states, verbatim, "Not agent-native. No agent cards, no per-agent reasoning ticker, no swipe-between-agents carousel." This surface is that agent-native UX. Per `AGENTS.md`, reopening scope is a deliberate decision, not a quiet feature add. Two doc changes are part of this work, not follow-ups:

1. **PRD edit.** Move the agent feed out of "What v0 is not" into current scope, and note that the host-side Space Agent and this phone-side agent feed are distinct surfaces (one is a host-local Spaces navigator, one is the phone observability surface).
2. **ADR.** Record two locked decisions: the phone-side agent-native observability surface, and the Mac host taking a runtime dependency on a bundled Bun sidecar (the ATC engine) for transcript normalization. Reference the ADR by number from `SPEC.md`.

## Architecture

```
Mac host (Swift menu-bar app)                 iPhone client (Swift/UIKit)
+-----------------------------+               +---------------------------+
|  AgentDeskHost              |               |  AgentDeskClient          |
|   existing capture/encode/  |   QUIC        |   existing video sink +   |
|   input/spaces (unchanged)  |   session     |   trackpad + spaces dots  |
|                             |  (input lane) |                           |
|   NEW: AgentFeedBridge -----+-- push msgs --+-> NEW: AgentSurface       |
|        ^                    |               |       (native container   |
|        | local IPC          |               |        hosting a WKWebView)|
|   +----+-------------+       |               |          |                |
|   | ATC engine       |       |               |          v injected store |
|   | (Bun sidecar)    |       |               |     reused React app:     |
|   |  claude.ts       |<------+-- reads ------+--   project list ->        |
|   |  codex.ts        |<------+-- (SSOT)      |     project detail ->      |
|   |  digest.ts       |       |               |     ActivityFeed/Markdown |
|   +------------------+       |               +---------------------------+
+-----------------------------+
        reads, unchanged source of truth:
          ~/.claude/projects/*.jsonl
          ~/.codex/state_*.sqlite + rollouts
```

The raw transcripts remain the single source of truth. ATC's engine is a reader over them. The host bridges the engine's normalized output onto the QUIC input lane. The iPhone renders it. Nothing in the capture, encode, input, or spaces paths changes.

### Why a Bun sidecar, not a Swift port

ATC's engine already holds roughly 9k lines of TypeScript doing the exact Claude and Codex normalization that is the durable asset here. Re-implementing the Codex SQLite plus rollout parsing (`codex.ts` is 559 lines, `digest.ts` 579) in Swift duplicates hard-won parsing and then taxes the project forever keeping two copies in sync as the transcript formats drift, exactly the duplication `AGENTS.md` warns against.

The Swift menu-bar host already manages its own process lifecycle, so spawning and supervising a child process is not new shape. The cost is bundling a Bun binary into the notarized DMG and managing the sidecar's lifecycle. That cost is real but one-time and well-trodden (many Mac apps ship embedded helper binaries). Both the sidecar and a hypothetical Swift port read the same SSOT files, so neither breaks single source of truth; this is a reuse-versus-runtime-simplicity call, decided for reuse.

Keeping the sidecar alive also keeps ATC's desktop dashboard usable against the same engine, so the desktop and phone observability surfaces share one normalization codebase.

### Rendering: reuse ATC's React in a local WKWebView

The agent surface renders by reusing ATC's existing React presentation components inside a `WKWebView`. The webview loads a static bundle from the app bundle (`file://` or a `WKURLSchemeHandler`), not a remote URL. React boots, registers a message handler, and the Swift host feeds it QUIC-delivered JSON through the bridge. React reconciles, including live incremental thread updates, the same reconciliation the dashboard already performs, with the Swift bridge as the data source instead of a WebSocket.

This does not violate AgentDesk's native-crispness thesis. That thesis was a reaction to AnyDesk streaming video of text (mushy pixels). `WKWebView` renders real text at native DPR; it is crisp. Code blocks, diffs, syntax highlighting, and collapsible tool calls are exactly what agent output needs, and the existing components already render them.

The native/web seam: **native owns "which surface am I on," React owns "which project/thread am I reading."** The project selector lives in the webview for v-next-1 (it already exists in the dashboard; building it native would duplicate it for no proven benefit, and it keeps the Swift-to-JS bridge dumb: data in, no navigation commands to sync). Graduating the project selector to native is a later option if the in-webview navigation feel disappoints; that path adds a native override without discarding the React selector, which still serves the desktop dashboard.

## Component reuse and the extraction

Verified against the ATC repository's `dashboard/`:

- The entire TCP coupling funnels through one module, `src/lib/engine.ts` (`engineHttp()` -> `http://<host>:7681`, `engineWs()` -> `ws://...`). Every `fetch`, `WebSocket`, and `EventSource` resolves through it. Inside the webview (`file://`, no reachable engine) all of those are dead, so the data layer, not the presentation layer, is what must change.
- `MarkdownView({ content })` is pure presentation, props only. `DiffBlock` and the row renderers are presentation.
- `ActivityFeed({ sessionId })` reuses cleanly for rendering (virtualized via `@tanstack/react-virtual`) but pulls data internally from `useSessionEventsStream(sessionId)`. That hook is the swap point.
- `useSessionEventsStream` and `sessionsStream.ts` are the data layer: initial page via `fetch`, live via `EventSource`, paging via `loadOlder`.

The data contract already exists, engine-normalized across both sources:

```ts
ActivityEvent { index, ts, type: "user" | "assistant" | "reasoning", blocks: ActivityBlock[] }
ActivityBlock { kind: "text" | "tool_use" | "tool_result" | "reasoning" | "compaction",
                text?, tool?, summary?, input?, preview?, hiddenChars?, hiddenLines?, callId? }
```

`callId` already pairs Claude `tool_use.id` and Codex `call_id`. This is the QUIC push payload, lifted verbatim; the components already speak it.

Extraction steps:

1. Funnel the two read hooks (`useSessionEventsStream`, `sessionsStream`) through an injectable data source. Desktop keeps the SSE/fetch path. The iOS bundle's source is a bridge-fed store: events arrive via `WKScriptMessageHandler`, get appended, and the hook exposes the same `{ events, loadOlder, windowStart, loading, error }` return shape. This is the SSOT-correct unification: one component codebase, two transports, two hosts (desktop dashboard, iOS webview).
2. Drop the write paths for read-only v1 rather than port them: worker DELETEs (`ProjectNode`, `OverviewNode`, `WorkerPane`, `canvasHelpers`), the `observed` POST (`useObservedPublish`), and the browser and terminal WS panes (`BrowserPane`, `TerminalPane`). They have no place on the phone.
3. Resolve `ActivityFeed`'s one inline `fetch` (lazy raw-block expansion, around line 897): either request it over the bridge or cut lazy expansion for v1, since the block `preview` and `text` are already present in the pushed payload.

Effort is roughly half a day to a day, not a deep refactor, because the coupling is funneled through one module and a handful of named hooks, and the data shape is already clean.

Known risk: `MarkdownView` renders via Milkdown Crepe, a full ProseMirror editor run read-only. That is heavy to bundle into a `WKWebView`. It works and is props-only, so it is acceptable for v1 reuse, but it is the first candidate to swap for a lighter read-only renderer (`marked` plus `highlight.js`) if bundle size or webview memory bites. Any such library lock passes the `AGENTS.md` dependency bar first (latest release, 100+ stars, real human maintenance).

## Data flow

```
ATC engine (Bun sidecar)                         iPhone WKWebView (React)
  normalizes -> ActivityEvent[]                    reused ActivityFeed / MarkdownView
        |                                                  ^
        | local IPC (stdout or loopback,                   | injected store
        |   host-internal, never exposed to phone)         | (same {events, loadOlder, ...})
        v                                                  |
  Swift AgentFeedBridge ----- QUIC input lane ------> WKScriptMessageHandler
   - on project select: request thread               - append events
   - subscribe to live session                       - React reconciles -> render
   - push ActivityEvent chunks and tails
```

The host pushes `ActivityEvent` chunks and a project index down the existing authenticated input lane as new message types. The webview's injected store appends them and the reused components render. No new transport, no new auth, and the payload schema is the dashboard's existing type.

## Wire contract

New message types on the existing QUIC session input lane, following the established `*Push` and request-response pattern (mirrors `DiagnosticsRequest` / `DiagnosticsSummary` / `DiagnosticsChunk` in `SPEC.md`). Each is one length-prefixed JSON frame routed by its `t` tag.

Client to host (requests):

```
AgentProjectsSubscribe  { }                                          // t: "agent-projects-sub"
AgentThreadSubscribe    { projectPath, source?, sessionId? }         // t: "agent-thread-sub"
AgentThreadLoadOlder    { sessionId, beforeIndex, limit }            // t: "agent-thread-older"
AgentThreadUnsubscribe  { sessionId }                                // t: "agent-thread-unsub"
```

Host to client (pushes):

```
AgentProjectsPush  { projects: [ProjectDigest] }                     // t: "agent-projects"
AgentThreadChunk   { sessionId, events: [ActivityEvent],
                     windowStart, total, isLive }                    // t: "agent-thread-chunk"
AgentThreadError   { sessionId, reason }                             // t: "agent-thread-error"
```

- `ActivityEvent` / `ActivityBlock` are the dashboard types above, lifted verbatim.
- `ProjectDigest` reuses ATC's existing `/api/projects/digest` row shape (project path, intent or title, source counts, primary session, bounded recent sessions, git state, liveness). The engine already produces it; the bridge forwards it.
- `source` is `"claude" | "codex"` when the caller filters; absent means the project's combined sessions.
- `AgentThreadChunk.isLive` distinguishes a seeded page (paging history) from a live append, mirroring the dashboard's seed-page-then-SSE semantics. `windowStart` and `total` carry the same paging anchors the existing hook uses.

Renaming any of these requires an ADR, consistent with the wire-shape rule in `SPEC.md`.

## Host wiring

- The Swift host spawns the Bun sidecar as a supervised child process and subscribes to its normalized output over local IPC (sidecar stdout or a loopback socket). This IPC is host-internal and never exposed to the phone.
- `AgentFeedBridge` translates between the sidecar and the lane message types: `AgentProjectsSubscribe` maps to the sidecar's project digest; `AgentThreadSubscribe` maps to a sidecar session-events subscription, whose pages and live appends stream back as `AgentThreadChunk`; `AgentThreadLoadOlder` maps to a bounded historical page; `AgentThreadUnsubscribe` tears the subscription down.
- The bridge attaches to the active session's input-lane transport through the same session registry the existing `inputLaneReadyHandler` uses, and resets its subscriptions when the lane re-attaches (session resume).
- Sidecar lifecycle is tied to the host: started when the host starts, stopped when it stops. A crashed sidecar surfaces as `AgentThreadError` to any active subscription and is restarted.

## Client surface

- A native container view controller, peer to the existing surfaces, owns only app-level chrome: the toggle between the control surface (video plus trackpad) and the agent surface, hosting the `WKWebView`, safe areas and status bar, and forwarding session lifecycle (background drop within one second, foreground resume) so the webview store can re-seed on resume.
- The `WKWebView` loads the bundled React app from the app bundle. The whole agent surface lives in React: project list, project detail (combined Claude and Codex), and thread (`ActivityFeed` plus `MarkdownView`). React owns navigation inside the surface.
- The Swift-to-JS bridge: outbound, the React app posts subscribe/older/unsubscribe intents that the container maps to the lane request types; inbound, the container delivers `AgentProjectsPush` and `AgentThreadChunk` payloads via `WKScriptMessageHandler` into the injected store.
- The iOS build gains a JS bundling step (a bundler build producing static JS and CSS copied into the app bundle as a resource), wrapped in a `just` recipe so `xcodebuild` depends on it. This is new cross-toolchain build complexity and is part of the work.

## Error handling

- A media or decode failure on the control surface does not affect the agent surface; both ride the session but the agent feed depends only on the input lane, which `SPEC.md` already keeps live independent of media.
- Session resume re-attaches the lane; the bridge re-establishes subscriptions and the webview store re-seeds the current thread rather than assuming continuity across the gap.
- A sidecar crash surfaces as `AgentThreadError` to active subscriptions; the React surface shows a non-fatal error state and retries on the next subscribe after restart.
- Backgrounding drops the session within one second per existing lifecycle; the agent surface shows the same suspended state as the rest of the app and re-seeds on foreground.

## Testing

- Native (mirrors the diagnostics tests): bridge message encode/decode round-trip for every new `t`-tagged type; subscription attach/detach across a simulated lane re-attach; sidecar-crash maps to `AgentThreadError`.
- React: the injectable data source swaps cleanly (store-fed versus SSE-fed) and the reused components render bridge-shaped `ActivityEvent`s; paging via the store-fed `loadOlder` preserves scroll anchoring.
- Sidecar to host: a subscription request produces ordered `AgentThreadChunk`s; `loadOlder` returns a bounded historical page; combined Claude plus Codex sessions appear under one project path.

## Build order

1. Decision record: PRD edit plus the ADR (gate; nothing else lands first).
2. Wire contract: the new lane message types in the host and client shared types, with round-trip tests. Contract seam first so host and client cannot drift.
3. Component extraction in ATC: funnel the read hooks through an injectable data source; the desktop dashboard stays green on the SSE path. Drop write paths and panes the phone does not use.
4. Host: spawn and supervise the Bun sidecar; `AgentFeedBridge` translating sidecar output to lane messages on the active session.
5. Client: native container plus the bundled React webview and the injected store; the JS bundling `just` recipe.
6. Device validation (gated on explicit go-ahead per the device-run checkpoint in `AGENTS.md`): crisp native scroll of a real combined Claude and Codex thread on the phone, within a live session.

## Cross-references

- Product intent: `PRD.md` (edited as part of this work).
- Technical shape and wire-shape rules: `SPEC.md` (references the new ADR).
- ATC engine and components: the private ATC repository (`engine/src/sources`, `engine/src/digest.ts`, `dashboard/src/features/canvas`).
- ATC observability decision: ATC ADR-0004 (project world-context timeline).
