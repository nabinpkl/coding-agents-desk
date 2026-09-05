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
| Virtual display | `deskzoom/` | Swift | launchd job, restarted only deliberately. See `AGENTS.md` "The virtual display". |

The loop is: edit TypeScript, reload the page. Neither the Mac host app nor the iPhone app needs
rebuilding for it, which is the entire point of the shape the repo is in.

Swift has not gone away. `just check` still runs six Swift package test suites, a Rust crate, and
the whole Xcode host test suite, and that gate is real. But it is a gate, not a workbench. Reach for Swift
only when a change needs a native capability TypeScript cannot have; `AGENTS.md`
("TypeScript-first WebView glue") states the bar.

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
- `packages/WorkspaceIDE/`, `packages/WorkspaceKit/` the IDE surface.
- `mock-design/` a visual reference from June, explicitly not an implementation target.
- `spikes/`, `tests/`, `agent-learning/` experiments and one-off harnesses.
- `ad` a June "agent say" Swift script at the root; `hooks.json.tmp` a temp file committed in July
  and never cleaned up.

**Stale documents that read as current, and are not:**

- `TASKS.md` heads a v15 pronunciation gap-finder arc from July. That is not what anyone is doing.
- `HANDOVER.md` is the 2026-08-25 desktop-park arc, already carrying a 2026-08-28 correction.

When a ledger and `git log` disagree, `git log` wins.

## Approaches that solve the same problem, side by side

Every row is checked in and compiles. None of them is dead in the sense of being deletable today,
and none of them should be extended without deciding which one you are in.

| Problem | Current approach | Also present | Note |
|---|---|---|---|
| Show a Mac display | sidecar WebRTC, `tools/grid-encoder` + werift | owned-media pipeline in `host/` + `client/`: libwebrtc, `OwnedTileCodec`, copyRect scroll prediction (ADR-0022/0023/0024) | the second is the iPhone-native path and is still built and tested by `just check`; new work is on the first |
| Reach a session that is locked or at the login window | noVNC on the Screen surface | nothing; the capture path structurally cannot | complementary, not competing |
| Zoom the desktop view | `crop`, re-aiming the capture (ported from DeskZoom) | `css`, transforming the picture | both live behind a switch in `zoomMode.ts`, deliberately, so they can be compared on one desk |
| Drive the desktop | sidecar HTTP plus the standalone helper (ADR-0109, ADR-0113) | the host's native lane | moved on purpose; the reasoning is at the top of `agent-feed/sidecar/src/http/windowRoutes.ts` |
| See a web page from the Mac | stream the screen | `chrome-extension` + `dom-bridge` DOM projection | the projection arc is dormant since July |
| Serve the panel's code | live Vite origin (`panel=live`) | bundled webview (`panel=bundled`) | both supported on purpose; bundled is how it ships |

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
   measurements, is in `AGENTS.md` under "The virtual display". It is the constraint that decides
   where the display holder must be installed and why changing the agent's desk is a sequence
   rather than a setting.

## Sibling repositories

Other checkouts under `~/projects` hold earlier or parallel takes on the same problem. They are not
references; check anything taken from them against this map first.

- `agent-desk-testflight-prev` a July snapshot of the pre-port shape.
- `agent-workspace-ide` tombstoned 2026-07-10, "retired into AgentDesk".
- `claude-mac-mouse` May, window and pointer control through CoreGraphics and Accessibility.
- `deskzoom` no longer exists; absorbed here on 2026-09-05.

## Re-deriving this map when it goes stale

It will. The method is cheap, so refresh it rather than trusting the date at the top:

```
git log --since="60 days ago" --name-only --format= | awk -F/ 'NF{print $1}' | sort | uniq -c | sort -rn
for d in */; do printf "%-24s %s\n" "$d" "$(git log -1 --format='%ad %s' --date=short -- "$d")"; done
```

Then read what `just check` runs and what `just host-run` launches. Those two answer "what is still
wired up" where the commit dates answer "what is still being worked on"; a directory needs both to
count as live.
