# Feature map

Which parts of this tree are the current path, which are finished, and which solve the same
problem a different way. Written 2026-09-05 against `bf4dc7f9`.

`PRD.md` says what is being built. `SPEC.md` says how v0 was shaped. `AGENTS.md` says how to work
here. This file exists because neither of those tells you that a directory you are reading was
superseded two months ago, and because several approaches to the same problem live side by side in
one tree with nothing in the code saying which one is current.

Two specific mistakes it is here to prevent:

- **Reaching for Swift because most of the tree is Swift.** It is not the compile path any more.
- **Carrying an approach out of a dormant directory into current work.** Both are checked in, both
  compile, and neither is labelled in the source.

## Where the work actually is

Four pieces, and only four, carry the current path:

| Piece | Path | Language | How a change reaches the running system |
|---|---|---|---|
| Panel UI | `packages/AgentPanel/Web/` | TypeScript / React | Vite dev server over the tailnet HTTPS origin. Edit, save, the page reloads. |
| Sidecar | `agent-feed/sidecar/src/` | TypeScript on Bun | `bun --watch` re-reads in process; measured ~4s to visible, pid unchanged. |
| Capture helper | `tools/grid-encoder/` | Swift | `just grid-encoder-install`, no app rebuild, no relaunch. |
| Virtual display | `deskzoom/` | Swift | launchd job, restarted only deliberately. See `docs/agents/desktop-and-display.md`. |

The loop is: edit TypeScript, reload the page. Neither the Mac host app nor the iPhone app needs
rebuilding for it, which is the entire point of the shape the repo is in.

Swift has not gone away, but as of 2026-09-05 it is not in the default gate either. `just check`
covers the current path: the sidecar and panel TypeScript, the JS build system, and `just
grid-encoder` for the one native helper that path spawns. Everything else native -- the Swift
packages, the Rust PTY manager, the Xcode host suite, and the shell tests of the launch machinery --
moved behind `just swift-check`, and the dormant voice arc behind `just voice-check`. `just
check-all` still runs everything. Reach for Swift only when a change needs a native capability
TypeScript cannot have; `agent-feed/sidecar/AGENTS.md` ("TypeScript-first glue and logging") states the bar, and run
`swift-check` when you do.

## How it got this shape

It began as a Swift Mac host plus a Swift iOS client, with one video pipeline built on libwebrtc
and a hand-written tile codec. Compile-and-reinstall dominated iteration: a wholemodule host build
measured ~300s against 26s for singlefile, and every phone-side change also cost an install and a
re-pair.

The escape was made in three steps, each removing one rebuild from the loop: the surface moved into
a webview; the webview's origin moved to a live Vite server; the sidecar behind it moved to
`bun --watch`. What is left of the native side is lifecycle, the authenticated relay, security
boundaries, and OS capabilities.

## The port that is still open

The directory is named `agent-feed` and its features are named for a feed of agent activity:
transcripts, sessions, usage, summaries. Nearly all work since August has been **desktop**:
streaming a display, controlling it, parking windows on it. The names lag the work. Read
`agent-feed/sidecar/src/http/` and you will find the desktop routes sitting under `/api/park/` next
to the feed routes, because that is where they landed, not because it is where they belong.

Do not "fix" this naming in passing. It is a rename across a live surface and belongs in its own
arc.

## Surfaces and containers

Three surfaces, chosen in `packages/AgentPanel/Web/src/app/BrowserSurfaces.tsx`:

- **Desktop** (the default) `features/desktop-viewer/` — WebRTC video of a display from the
  sidecar's grid-encoder, with its own zoom and control model.
- **Feed** `features/activity-feed/` and neighbours — the original agent-activity surface.
- **Screen** `features/screen-viewer/` — noVNC. It dials `/vnc` on its own origin, which **only the
  Vite dev server provides** (`vite.config.ts`, `vncBridge`), so this surface does not exist in a
  bundled panel. It earns its place because RFB drives whichever session it shows, including the
  login window, where the capture path can only show a picture nobody can click.

The same code runs in three containers: a plain browser tab, the Mac host's webview, and the iPhone
app. The panel picks its transport by whether a native message handler is present.

## Directory map

**Live** — current path, changed within the last two weeks:

- `packages/AgentPanel/` the panel, and the busiest directory in the repo.
- `agent-feed/sidecar/` the TypeScript backend behind it.
- `tools/grid-encoder/` the Swift capture and input helper the sidecar spawns.
- `deskzoom/` the virtual display, absorbed 2026-09-05. Only `--display-only` and the launchd
  recipes matter here; its viewer and fake cursor are the original standalone tool.
- `architecture-decisions/` still the place a locked decision goes.

**Recent but not current** — the native halves, last touched late August / early September:

- `host/` the Mac app: lifecycle, QUIC to the phone, the owned-media pipeline, window placement.
- `client/` the iOS app.
- `terminal/` the PTY runtime (Rust manager, Swift client, vendored xterm) behind the terminal surface.
- `packages/AgentDeskWire/`, `packages/WebPanelKit/`, `packages/WindowPlacement/` the shared native
  libraries those two apps build on.

**Dormant** — nothing since mid-August at the latest, and no current work depends on them:

- `gesture-agent/`, `voice-assets/`, `packages/InteractionPanel/`, `packages/KeyboardDictation/`
  the voice arc, last touched 2026-08-14 and older.
- `chrome-extension/`, `dom-bridge/`, `chrome-test/`, `packages/BrowserProjection/` the browser
  projection arc.
- `packages/WorkspaceIDE/`, `packages/WorkspaceKit/`. The name is now wider than the contents: the
  IDE half moved to the panel and the sidecar on 2026-09-10 (ADR-0115) and was deleted from here.
  What is left is `WorkspaceFileViewer`, the single-file `app://` viewer, which is NOT dormant --
  `host/AgentDeskHost/WorkspaceShell/Editor/FileViewer.swift` opens it.
- `mock-design/` a visual reference from June, explicitly not an implementation target.
- `spikes/`, `tests/`, `agent-learning/` experiments and one-off harnesses.
- `ad` a June "agent say" Swift script at the root; `hooks.json.tmp` a temp file committed in July
  and never cleaned up.

**Stale documents that read as current, and are not:**

- `HANDOVER.md` is the 2026-08-25 desktop-park arc, already carrying a 2026-08-28 correction.
- `TASKS.md` at the root is the v17 workspace-IDE arc, opened 2026-09-10. The one that headed a
  July voice arc was retired on 2026-09-05 to
  `tasks/archive/2026-09-05-v15-voice-and-v16-typescript-desktop-control.md`, which names the single
  task still open (R278, a post-approval `just host-run` deployment check).

When a ledger and `git log` disagree, `git log` wins.

## Session providers

Sessions run in **Claude** and **opencode**, and a handover runs between those two. Two more
providers are still wired into the sidecar and still put rows in the session lists, and neither
is current: **Pi** (dormant since 2026-09-13) and **Codex** (dormant since 2026-10-11). Both on
the owner's word; "Seven things this map exists to stop you getting wrong", below, has what each
still touches. A gap on a Pi or Codex row is not a bug to fix, and neither is a provider to extend.
A Claude session runs in Claude Code's terminal UI by default, and the Agent SDK runner is picked at
creation, under the same heading.

## Seven things this map exists to stop you getting wrong

Moved here from `AGENTS.md` on 2026-10-17; the one on Claude's run modes was added 2026-10-18 and
reversed 2026-10-20.
The root `AGENTS.md` keeps one line for each.
They are easy to infer backwards from the shape of the tree.

- **Swift is not the compile path.** Most files here are Swift and `just check` still compiles a lot
  of them, but the working loop is TypeScript: the Vite-served panel in `packages/AgentPanel/Web/`
  and the supervised sidecar in `agent-feed/sidecar/src/`, with `tools/grid-encoder` as the
  native helper behind them. An edit reaches the running system without a rebuild: in place for
  most panel edits, by a supervised restart for the sidecar ("What an edit costs the open panel" in
  `packages/AgentPanel/Web/AGENTS.md`).
  This repo began as a Swift host plus a Swift iOS client and moved off that path because compiling
  and reinstalling dominated iteration; the Swift that remains is lifecycle, transport, security
  boundaries, and OS capabilities.
- **Several approaches to one problem are checked in at once, and the code does not say which is
  current.** A superseded pipeline still compiles and still passes its tests. Do not extend one
  because you found it first, and do not merge two in your head across a compaction: check the map,
  and check `git log` for the directory you are about to edit.
- **Pi is no longer used as a session provider here** (recorded 2026-09-13, on the owner's word).
  Sessions run in Claude and opencode (Codex is dormant too, below). The Pi provider is still
  wired in and still looks current: `PiAgentBackend` registers in `agent-feed/sidecar/src/server.ts`, Pi sessions still show in the
  sidebar with a PI badge, and `PRD.md` and `SPEC.md` still describe Pi as the directly controlled
  provider. Do not extend it, and do not treat a gap on a Pi row as a bug to fix -- its tool rows
  carry no summary, for one. The Pi SDK itself is NOT dead: `summary/summaryRuntime.ts` runs the
  turn summarizer on `@earendil-works/pi-coding-agent` (the `summaryModel` in `/api/config`), so
  retiring Pi means removing the provider, not that dependency.
- **Codex is dormant as a session provider** (recorded 2026-10-11, on the owner's word). Sessions
  run in Claude and opencode, and a handover runs between those two. Codex is still wired in and
  still looks current: `CodexLiveBackend` registers in `agent-feed/sidecar/src/server.ts`,
  `transcripts/catalog/codexCatalog.ts` reads its rollouts and its own `archived` column,
  `transcripts/codex/` parses them, and Codex sessions still show in the session lists with a Codex
  badge (`SourceBadge.tsx`). Do not extend it, do not suggest extending it (making it a handover
  source was proposed once from the code's own comments), and do not treat a gap on a Codex row as
  a bug to fix.
- **A Claude session runs in its terminal UI by default; the Agent SDK runner is the other mode,
  picked at creation** (recorded 2026-10-20, on the owner's word, reversing the 2026-10-18 entry that
  made the SDK the default and the terminal mode dormant). The reason is remote control: Claude
  Code's remote control reaches a session in its terminal UI and not one in the SDK runner, and it is
  how a session is still reached while the sidecar is down. So the panel's harness pickers, a Bot's
  +, and a fork's draft card all start on Claude Code (`harness: "claude"`, which sends
  `claudeMode: "terminal"`), and a start that names no mode runs in the terminal. Both modes are
  current and both are kept working: the terminal mode and the code that drives a session through
  its pane (the sidecar's `input/`, the panel's `features/cli-input/`), and the SDK runner (ADR-0143,
  `claudeMode: "sdk"`, `agent-feed/sidecar/src/claude-sdk/`, the panel's `useSdkSession`). One start
  still picks the SDK on purpose: a scratch chat (`scratchSessionRoutes.ts`), because a new folder
  makes the terminal ask whether to trust it on every chat, and the runner does not ask.
- **The sidebar's Bots tab is dormant in favour of Canvas** (recorded 2026-09-15, on the owner's
  word). Canvas is where Bots are read and acted on. The Bots tab (`AgentSidebarMode` `"bots"` in
  `features/sidebar/AgentSidebar.tsx`) is still wired in and still looks current: it sits between
  Sessions and Canvas, lists every Bot, and opens a Bot's session in the main thread view. Do not
  extend it, and do not treat a gap in it as a bug to fix. The known one is a two-machine gap: that
  view is handed the shell's `sessionViewContext`, whose `feed` is whichever machine the tab bar's
  picker points at, so a peer's Bot session opened there sends its transcript, composer and image
  drops to the wrong sidecar. Canvas cards do not have this gap, because each card's context comes
  from `shellMachines.contextFor`. One piece is NOT dormant, so retiring the tab does not mean
  removing it: `BotSidebarPanel` is the Canvas tab's roster too, rendered there with the `canvas`
  prop. What IS the tab's alone is `thread.openBotSession`: the Canvas roster opens a session with
  `roster.openSessionOnCanvas` instead.
- **The current iteration is Canvas and its session cards; the sidebar's Sessions tab is dormant**
  (recorded 2026-09-15, on the owner's word). Sessions are read, driven and judged on a Canvas
  session card (`features/bots/cards/BotSessionCard.tsx`), at `?entry=feed&view=canvas`. The
  Sessions tab (`AgentSidebarMode` `"sessions"`, its `ProjectSidebarItem` list) and the full-width
  thread view it opens in the main column (`displayedThread` in `app/AgentPanelApp.tsx`) are still
  wired in and still look current: a selected session renders there with its composer and its
  whole transcript. Do not extend that view, do not treat a gap in it as a bug to fix, and **do not
  verify a panel change there**. It is the easy page to reach -- seeding `agent-panel.selection`
  lands on it -- and it is not what the owner is looking at: a card is a narrow column on the Bot's
  hue-tinted `--session-view-*` surfaces, where the thread view is a wide one on plain `--card`, so
  a width, a colour or a scroll judged in one says little about the other. What is NOT dormant is
  `SessionView` and everything under it (`features/session-view/`, `features/activity-feed/`): the
  card renders that same component, so a transcript change lands on the card too, and retiring the
  tab means removing the tab and its main-column arm, not the view. Nor is the tab's project list
  (`ProjectSessionList`): since 2026-10-05 it is also the Canvas tab's Sessions view, which opens a
  session in `SessionModal` over the canvas rather than in the main column.

## Approaches that solve the same problem, side by side

Every row is checked in and compiles. None of them is dead in the sense of being deletable today,
and none of them should be extended without deciding which one you are in.

| Problem | Current approach | Also present | Note |
|---|---|---|---|
| Show a Mac display | sidecar WebRTC, `tools/grid-encoder` + werift | owned-media pipeline in `host/` + `client/`: libwebrtc, `OwnedTileCodec`, copyRect scroll prediction (ADR-0022/0023/0024) | the second is the iPhone-native path and is still built and tested, now by `just swift-check`; new work is on the first |
| Reach a session that is locked or at the login window | noVNC on the Screen surface | nothing; the capture path structurally cannot | complementary, not competing |
| Zoom the desktop view | `crop`, re-aiming the capture (ported from DeskZoom) | `css`, transforming the picture | both live behind a switch in `zoomMode.ts`, deliberately, so they can be compared on one desk |
| Drive the desktop | sidecar HTTP plus the standalone helper (ADR-0109, ADR-0113) | the host's native lane | moved on purpose; the reasoning is at the top of `agent-feed/sidecar/src/http/windowRoutes.ts` |
| See a web page from the Mac | stream the screen | `chrome-extension` + `dom-bridge` DOM projection | the projection arc is dormant since July |
| Serve the panel's code | live Vite origin (`panel=live`) | bundled webview (`panel=bundled`) | both supported on purpose; bundled is how it ships |
| Speak to someone listening on the phone | the speech process (`agent-feed/speech/`) pushing what it makes to `public/experiments/local-test.html?push=1`, which mixes it with noise (`audio/speechPushExperiment.ts`) | Agent Radio: one AAC stream mixed in the audio process (`audio/audioStream.ts`, `public/listen.html`) | the first is still an experiment, but it is where the sidecar's speech goes (a turn finishing, a reply read aloud), and it takes over `/api/audio/speak` while it is checked in, so Agent Radio plays only noise (2026-10-21) |
| Archive a session | ours, `session-archive.json` beside `bots.json` (ADR-0126) | Codex's own `archived` column, read by `codexCatalog.ts` to leave those threads out | never write Codex's; a session Codex archived is simply absent, not "archived" here |
| Run a Claude session | the terminal UI in a tmux pane, driven through its screen (`input/tmuxComposer.ts`, `input/question/`) | the Agent SDK runner in that same pane, driven over a socket (`claude-sdk/`, ADR-0143); the runner is a pipe the sidecar reads, and one on older code relaunches with resume when idle (ADR-0144) | both current on purpose (2026-10-17): terminal is the default, SDK is chosen at creation, and one session never has both at once; an idle session can be switched between them, a stopped one reopens the way it last ran, and a fork runs the way its source last ran |

## The virtual display tangent, and where it led

Worth keeping as a chain, because each link is only explicable by the one before it and the last
link is a hard constraint on everything else.

1. A bigger desk than the hardware has means a **virtual display**, which is what `deskzoom/` was
   built for.
2. Driving windows on that display from a script wanted a **second pointer**, which macOS does not
   have. The workaround was a fake cursor pressing elements through Accessibility.
3. That works for buttons and typing but **not for command shortcuts**: a key equivalent travels the
   key window's responder chain, an inactive app has no key window, and every focus-free route
   measured the same nothing on 2026-09-04.
4. So the agent got its **own login session** (`agent`), which has its own pointer, its own keyboard
   focus, and its own active application, running concurrently with the console user. Command
   shortcuts work there because nothing is being borrowed.
5. But a virtual display can only be created by **whichever session holds the console**, and an
   off-console session sees only a frozen copy taken when it was created. That rule, with its
   measurements, is in `docs/agents/desktop-and-display.md`. It is the constraint that decides
   where the display holder must be installed and why changing the agent's desk is a sequence
   rather than a setting.

## Sibling repositories

Other checkouts under `~/projects` hold earlier or parallel takes on the same problem. They are not
references; check anything taken from them against this map first.

- `agent-desk-testflight-prev` no longer exists; removed 2026-09-11. It was never a sibling
  repository at all -- it was a linked worktree of THIS checkout, detached at `2ef9e849`, which
  is an ancestor of `main`, so the July snapshot it held is in this history and the 601MB on
  disk was build output. `git worktree add --detach ../agent-desk-testflight-prev 2ef9e849`
  brings it back.
- `agent-workspace-ide` tombstoned 2026-07-10, "retired into AgentDesk".
- `claude-mac-mouse` May, window and pointer control through CoreGraphics and Accessibility.
- `deskzoom` no longer exists; absorbed here on 2026-09-05.

## Re-deriving this map when it goes stale

It will. The method is cheap, so refresh it rather than trusting the date at the top:

```
git log --since="60 days ago" --name-only --format= | awk -F/ 'NF{print $1}' | sort | uniq -c | sort -rn
for d in */; do printf "%-24s %s\n" "$d" "$(git log -1 --format='%ad %s' --date=short -- "$d")"; done
```

Then read what `just check` and `just swift-check` run, and what `just host-run` launches. Those two answer "what is still
wired up" where the commit dates answer "what is still being worked on"; a directory needs both to
count as live.
