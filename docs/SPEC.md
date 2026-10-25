# AgentDesk SPEC

> Authoritative for **how** AgentDesk is built: its processes, module boundaries and contracts, and
> the rules they follow. What it is for is in [PRD.md](PRD.md), in this folder. How to work
> in the repository is in [AGENTS.md](../AGENTS.md), and which directories are current is in
> [FEATURE-MAP.md](../FEATURE-MAP.md). The native apps' design, their wire shapes included, is in
> [dormant-native-design.md](dormant-native-design.md).

## Shape of the system

Two TypeScript processes do the work on each machine, and both run from source:

- **The sidecar** (`agent-feed/sidecar/`) runs on Bun under a supervisor. It starts sessions in tmux
  panes, reads every session's transcript, drives the sessions' terminal UIs, and serves the HTTP
  API the panel uses.
- **The panel** (`packages/AgentPanel/Web/`) is a React app served by Vite's dev server. The dev
  server also forwards `/api` to the sidecar, so a browser talks only to the panel's own origin.

```
 browser (Mac, phone)
      |  http://127.0.0.1:5173, or https://<mac>.<tailnet>.ts.net:5173 in tailnet mode
      v
 panel dev server ---- /api ------------------> sidecar on 127.0.0.1:7682 (this machine)
      |           ---- /session/<id>/api ----> other login sessions' sidecars (from the board)
      |                                    \-> sidecars on other machines (declared peers)
      +-- /vnc --> macOS Screen Sharing on 127.0.0.1:5900

 sidecar --+-- tmux panes running claude and opencode
           +-- ~/.claude/projects (read only), opencode serve, the Agent SDK runner
           +-- grid-encoder helper (screen capture and input, over stdout and stdin)
           +-- audio process (port + 1) and speech process (port + 8), under the same supervisor
```

Native code stays only where TypeScript cannot reach: the screen-capture and input helper
(`tools/grid-encoder/`), the virtual display (`deskzoom/`), the PTY runtime (`terminal/`), and the
Mac app (`host/`), which starts and supervises the two processes at login. The iPhone app
(`client/`) is dormant.

## Stack

| Layer | Choice | Decision |
| --- | --- | --- |
| Panel | React 19, TypeScript 7, Vite 8, Tailwind 4; reads through TanStack Query 5, shared state in zustand 5; Vitest 4 | ADR-0146, ADR-0149 |
| Sidecar | Bun 1.4, from mise as the repository's `mise.toml` pins it (ADR-0157), and TypeScript 7; Claude's Agent SDK for the SDK runner, opencode's own client, the Pi SDK for turn summaries, the MCP SDK, werift for WebRTC, web-push, Sentry's SDKs delivering to a local archive | ADR-0143, ADR-0132, ADR-0157 |
| Contract | `agent-feed/wire/`: TypeScript types only, shared by both through a `tsconfig` path mapping | `agent-feed/wire/README.md` |
| Sessions | tmux; Claude Code in its terminal UI by default, or the Agent SDK runner in the same pane; opencode's serve and its TUI | ADR-0116, ADR-0143 |
| Transport to the browser | HTTP with JSON, Server-Sent Events for every live view, WebRTC for desktop video and its control channel; HTTP/2 over TLS in tailnet mode | ADR-0109 |
| Screen capture and input | `tools/grid-encoder/`, Swift: ScreenCaptureKit, VideoToolbox H.264 and HEVC, `CGEvent` input, Accessibility | ADR-0109, ADR-0113 |
| Terminals | a vendored xterm.js fork in the panel; tmux panes; the Rust `pty-vault` and `pty-manager` for terminals that resume a CLI | ADR-0108, ADR-0117 |
| Network | loopback, and Tailscale for other devices and machines | |
| Messaging hub | `agent-feed/hub/` on Bun with the MCP SDK, deployed with Docker behind Cloudflare Access | `docs/agent-messaging.md` |
| Lint and format | oxlint and oxfmt, enforced by the repository's gate | `.oxlintrc.json`, `.oxfmtrc.json` |

## Processes and how they start

### The sidecar and its supervisor

`agent-feed/sidecar/src/supervisor.ts` runs the sidecar (`src/server.ts`) as a child process and
replaces it when its source changes. It also runs two more children:

- the **audio process** (`src/audio/audioServer.ts`), on loopback at the sidecar's port plus one,
  which keeps audio listeners' streams open across the sidecar's restarts;
- the **speech process** (`agent-feed/speech/speech_server.py`), at the sidecar's port plus eight,
  started only once `just speech-voice` has installed its Python environment and voice.

The supervisor replaces the sidecar only when every changed file parses, the tree's imports resolve
(`Bun.build` in a child process, about 40 ms), and the tree typechecks without an error the running
tree did not already have (TypeScript 7 in a child, a second or two). It waits until the sidecar's
tree and the panel's have been quiet for 3 seconds (`AGENT_FEED_SUPERVISOR_QUIET_MS`). It replaces
itself, by exiting, when its own sources change. A reader can hold restarts from the panel's Profile
menu (`POST /api/supervisor`). The supervisor writes its state to the board described under [Sidecar
addresses](#sidecar-addresses-and-the-trust-boundary), where the panel reads it.

The sidecar listens on `AGENT_FEED_HOST` (default `127.0.0.1`) and `AGENT_FEED_PORT` (default
`7682`). It reads its settings once, at start, and `agent-feed/sidecar/src/config/` is the one place
they are read.

### The panel's dev server

`just agent-webview-dev [port] [sidecar origin]` starts it, by default on port 5173 with the sidecar
at `http://127.0.0.1:7682`. `AGENTDESK_PANEL_LISTEN` picks how far it listens: `loopback` (the
default), `tailnet` (the Mac's Tailscale address and loopback, over TLS with a certificate from
`tailscale cert`, and so over HTTP/2), or `network` (every interface, plain HTTP). Its plugins in
`packages/AgentPanel/Web/src/app/dev-server/` and `vite.config.ts`:

- forward `/api` and `/session/<id>/api` to sidecars in a middleware (`sidecarProxy.ts`), never in
  Vite's `server.proxy`, which would downgrade the origin to HTTP/1.1 and starve the page's event
  streams;
- compress responses and move source maps to `/@panel-source-map` (`slimResponses.ts`), which took a
  cold load on a phone from 37 MB to about 2.7 MB (measured 2026-10-17);
- serve the session index (`sidecarBoard.ts`), relay `/vnc` to Screen Sharing behind the same checks
  the sidecar applies (`upgradeGuard.ts`), and hold the panel's own hot reload while a reader holds
  updates from the Profile menu (`publishMode.ts`).

### Launch paths

- **From a terminal**, as in the README: the supervisor in one terminal and the dev server in
  another.
- **`just host-run`** builds and installs the Mac app and launches it. The app starts the sidecar's
  supervisor (live) or a compiled sidecar (bundled), and loads the panel from the dev server (live)
  or from a built copy (bundled). Because it installs and launches an app, agents working in this
  repository wait for the owner's approval before running it ("Hardware is a checkpoint" in
  AGENTS.md).
- **At login**, `just dev-login-install` installs four launchd jobs named after the Mac app's bundle
  id: `.devlogin` starts the installed app, `.paneldev` keeps the dev server running,
  `.remotesidecars` keeps peers' sidecars running and their sources current, and `.proxyobserver`
  relays the Claude traffic mirror to peers. `docs/agents/dev-loop.md` has the reasons for each.
- **On another machine**, `tools/remote-sidecar.sh` (`just remote-sidecar-setup`, `-run`, `-watch`,
  `-status`, `-stop`) copies the sidecar's sources over ssh and runs its supervisor there, bound to
  that machine's tailnet address.

## Sidecar addresses and the trust boundary

The page reaches every sidecar through its own origin, and it never has a sidecar's host and port or
a token. `/api` reaches this machine's sidecar. Each other sidecar is reached at
`/session/<id>/api`:

- every sidecar on the Mac, in any macOS login session, writes a descriptor file to the board,
  `/Users/Shared/agentdesk/sidecars/` (`AGENTDESK_SIDECAR_REGISTRY`), which the dev server serves as
  `/session/index.json` and `/session/stream`, so sidecars in other login sessions appear there;
- sidecars on other machines cannot write to that board, so they are declared in
  `AGENTDESK_PANEL_REMOTE_SIDECARS` as `id=host:port`, comma separated.

The sidecar does not authenticate requests or read an `Authorization` header, and where each process
listens is the boundary: loopback, or the tailnet, where WireGuard authenticates each device.
`src/http/requestGuard.ts` runs before every route and refuses a `Host` header outside
`config.allowedHosts` (loopback, the bind address and `AGENT_FEED_ALLOWED_HOSTS`) and a request
whose `Sec-Fetch-Site` is `cross-site` or `same-site`, which keeps web pages in the owner's own
browser out. A new way of reaching the sidecar is a new `allowedHosts` entry, never a removed check,
and a token is added only together with a sidecar that checks it. [SECURITY.md](../SECURITY.md) is
the same model written for someone deciding whether to run AgentDesk.

## Contracts

### Wire types

`agent-feed/wire/` is the one definition of everything that crosses the sidecar's HTTP boundary. It
contains types only (every declaration in it disappears at type erasure), uses long keys, and does
not import from the sidecar or the panel. Both consumers map `@agentdesk/agent-feed-wire` to it in
their `tsconfig.json` and import it with `import type`. Its files are named for what they describe:
`session.ts`, `activity.ts`, `bot.ts`, `terminal.ts`, `desktop.ts`, `arena.ts`, `messaging.ts` and
the others.

### HTTP API

JSON requests and responses, and Server-Sent Events for every view that updates live. The route
families:

| Path | What it serves |
| --- | --- |
| `/api/config` | the sidecar's settings, its supervisor's state and its source version |
| `/api/projects`, `/api/sessions` | the catalog of projects and sessions, one session's events, renames, forks, brackets, images and subagent transcripts |
| `/api/agent-sessions` | starting sessions, and handover between Claude Code and opencode |
| `/api/bots` | the Bot roster, its stream, placements on the Canvas, and Bot commands |
| `/api/tmux`, `/api/terminals` | the machine's tmux windows and panes, and the terminals a panel has open |
| `/api/workspaces` | the IDE: trees, files, git, history and search |
| `/api/park`, `/api/window` | the Desktop tab: displays, parking, window capture over WebRTC, and native window composers |
| `/api/arena` | Arena runs, their lanes and their folders |
| `/api/hub`, `/api/asks` | the messaging hub, and questions an agent asks the owner |
| `/api/push`, `/api/speech`, `/api/audio` | web push subscriptions, speech, and the audio channel |
| `/api/usage`, `/api/limits` | token use per vendor, and live rate-limit meters |
| `/api/supervisor`, `/api/telemetry` | holding restarts, and the panel's telemetry envelopes |

## Sessions

### The catalog

`src/transcripts/catalog/` keeps one record for every session the machine can show:

- **Claude Code**: transcripts under `~/.claude/projects`, read only. One recursive watch covers the
  whole folder (`watchTree.ts`), and every write is routed from it to whoever reads that transcript
  (`transcriptWrites.ts`), so a followed transcript does not need a watch of its own.
- **opencode**: the sessions of this machine's `opencode serve`, read through opencode's own client
  (ADR-0116, ADR-0132) at `AGENT_FEED_OPENCODE_URL` (default `http://127.0.0.1:49374`), with the
  password from `~/.config/opencode/service.json` or `AGENT_FEED_OPENCODE_PASSWORD`. One serve runs
  per machine.
- **Codex and Pi** are still read (Codex's SQLite database, and Pi sessions the sidecar hosts) and
  are dormant as providers.

A transcript row is named by the byte its line starts at (ADR-0124), and a thread view loads ranges
of rows and seeks to a position, so opening a card costs the rows it shows and not the length of the
session (ADR-0125). A live mirror of Claude Code's network traffic, from proxy-agent's observer at
`AGENT_FEED_PROXY_OBSERVER_ENDPOINT` (default `http://127.0.0.1:9155`), adds a turn's text before
the transcript has it. proxy-agent is a separate app outside this repository, and without it the
transcript is the only source.

### Session launch

`src/terminal/session-panes/claudeSessionLaunch.ts` starts every Claude session, whether a reader
asked for a new one, a Bot is being created, or a session is being forked, so all three agree on the
pane name, the command and the identity stamp on the tmux session. The pane runs zsh as a login
shell (`/bin/zsh -l`) with the sidecar's `PATH` exported, then
`claude <permission flags> <mods> --session-id <id> -n <title>`:

- the permission flags are `--permission-mode auto --allow-dangerously-skip-permissions` by default
  (`AGENT_FEED_CLAUDE_PERMISSION_MODE`, `AGENT_FEED_CLAUDE_ALLOW_BYPASS`);
- the mods are three Claude Code plugins in `agent-feed/sidecar/mods/`, each loaded with
  `--plugin-dir` for that session only: `prompt-guard`, which limits the prompts other mods may
  submit; `agentdesk-hub`, which delivers hub messages; and `ask-owner`, which adds the `ask_owner`
  tool to the session;
- a resume adds `--resume <id>` with the model and effort the session last ran with (ADR-0145), and
  a fork adds `--fork-session`.

A Claude session runs in its terminal UI by default. The other mode is the Agent SDK runner, which
runs in the same pane and is chosen when the session is created (ADR-0143). The runner is a pipe
that the sidecar reads, and a runner on older code relaunches with resume once it is idle
(ADR-0144). Scratch chats start in the SDK mode, because a new folder would make the terminal UI ask
whether to trust it. An opencode session is created through the serve, and its TUI gets a pane of
its own (ADR-0120, ADR-0121).

`idleSessionSweep.ts` closes the pane of a session that is not on any Bot, is not a Father, and has
been idle for `AGENT_FEED_IDLE_CLOSE_AFTER_MS` (two hours by default), and opening the session again
resumes it. `staleClaudeSessions.ts` finds the sessions whose launch flags or CLI version have moved
since they started, and, when asked, restarts those of them that are idle.

### Input to a session

- **In the terminal UI**, the composer is read off the pane with `tmux capture-pane` and typed with
  `tmux send-keys` (`src/input/tmuxComposer.ts` and `src/input/composer/`). The same reading answers
  Claude Code's question dialogs (`src/input/question/`), switches the permission mode from its
  footer, and drives the rewind picker. Images are handed over as a file the CLI agrees to read. The
  composer never types into a session through Claude Code's messaging socket (ADR-0142).
- **In the SDK runner**, questions and approvals arrive and are answered as data.
- **In opencode**, prompts and aborts go through the serve.
- **`ask_owner`**: the `ask-owner` mod's tool posts the question to `/api/asks`, where it waits
  until the owner answers it in the panel.
- **What a session reports about itself**: a `<task-state>` block at the start of a reply describes
  the task it took on, and a `<spoken-status>` block at the end is what the speech process reads out
  (`src/transcripts/taskState.ts`, `src/transcripts/spokenStatus.ts`). Both are conventions of the
  agents' own instructions, read where they appear.
- **Handover** turns a session into the one prompt its successor starts from: the compaction summary
  and every turn since, or every turn for a session that never compacted, from Claude Code to
  opencode or back (ADR-0119, ADR-0122).

## Bots and the Canvas

A Bot is a name, a directory and the sessions curated in it. Its record lives in `bots.json`
(`AGENT_FEED_BOTS_PATH`, by default in `~/Library/Application Support/agentdesk-agent-feed/`) on the
machine that has its directory, and the panel merges every machine's roster into one Canvas
(`features/bots/botMachines.ts`). Whether a Bot and each session stand on the Canvas, and where, is
kept on the Bot's record, so the Mac and the phone agree. A browser would keep it separately for
each origin and profile. One Bot per machine can mark one of its sessions as the Father, which the
panel shows in a floating window. Archived sessions are listed in `session-archive.json` beside
`bots.json`, which is AgentDesk's own and never a provider's store (ADR-0126). A session sets its
current task with the `set_task` tool, which renames its bracket
(`POST /api/sessions/:source/:id/bracket`).

## Terminals

`/api/tmux` lists a machine's tmux windows and panes (ADR-0117). `/api/terminals` opens a terminal
through one of two backends (`src/terminal/agentTerminalBackends.ts`): joining a tmux pane, or the
PTY manager for a CLI resumed in a process the sidecar owns. Every viewer of a terminal shares one
stream, and a viewer never resizes what it views: the wall follows the pane's size (ADR-0118). The
panel draws terminals with the xterm.js fork in `terminal/vendor/xterm/`.

The PTY runtime is Rust: `pty-vault` keeps the PTY descriptors and `pty-manager` keeps terminal
state and replay, and either can be updated without ending a session (ADR-0072, ADR-0080). The Mac
app starts both. A sidecar running without them reports the PTY backend unavailable and still joins
tmux panes. A PTY session lives until its process exits or someone kills it explicitly (ADR-0078).

## IDE

`src/workspace/` serves the IDE tab (ADR-0115): the registered workspaces (`workspaces.json`), their
trees, bounded file reads and writes (`AGENT_FEED_WORKSPACE_MAX_TEXT_BYTES`), what git reports as
uncommitted, the branch's commits with their patches, and search on ripgrep (ADR-0123). One watch
per repository is shared by every reader of it (`repositoryWatch.ts`). On macOS that is one
recursive watch, and on Linux one watch per directory, because a recursive watch there walks the
whole tree on the main thread.

## Desktop and Screen

The Desktop tab streams a display or a window from the grid-encoder helper.
`just grid-encoder-install` builds the helper and installs it in the runtime folder (ADR-0113), and
the sidecar runs a copy per encoder (`src/desktop/encoderSlots.ts`). The helper writes frames to
stdout as `[1 byte kind][4 bytes length][payload]`. One encoder runs per capture target, because two
ScreenCaptureKit captures of one target starve each other, and a second viewer joins the running one
(`webrtcEncoderPool.ts`). WebRTC is only the transport: werift sends the helper's H.264 or HEVC (RFC
6184 or RFC 7798 packetization) on `POST /api/park/tile/:windowID/webrtc`. The viewer zooms either
by re-aiming the capture (`crop`) or by scaling the picture (`css`), behind one switch
(`features/desktop-viewer/zoom/zoomMode.ts`).

Capture needs Screen Recording permission and input needs Accessibility, both granted to the app
that starts the sidecar. On the author's Mac that app is the Mac app. Parking gathers windows from the
Desktops and lays them out as a staggered ladder, and restoring puts each one back. The park's
manifest is written before the first window moves, so a park can be restored after the sidecar dies
(`src/park/`). The virtual display (`deskzoom/`) runs as a launchd job, and only the login session
on the console can create one (`docs/agents/desktop-and-display.md`).

The Screen tab is noVNC, connected through the dev server's `/vnc` relay to macOS Screen Sharing.
Only the dev server provides `/vnc`, so the tab does not exist in a bundled panel.

### First-party WebView desktop control

The Web desktop viewer uses one ordered WebRTC data channel named `agentdesk-control-v2` for pointer
movement, clicks, scroll, key batches, correlated focus queries, cursor feedback, delivery results,
and controller ownership. Its native source metadata advertises `desktopControlVersion: 2`; a mismatch
disables control with an explicit error while leaving the video track viewable. Messages are bounded
to 16 KiB, key batches to 256 events, sequences to positive 32-bit integers per channel, and focus
correlation to UUIDs. The closed key set is ANSI A-Z, 0-9, reviewed US punctuation, and the declared
control/navigation keys. There is no pointer-v1 fallback or second keyboard transport (ADR-0109).

AgentPanel TypeScript owns the keyboard state machine (`unavailable`, `hidden`, `pending`, `shown`),
the hidden 16 px textarea, DOM `beforeinput`/composition/paste/physical-key capture, ANSI conversion,
sticky modifiers, Auto preference, secure metadata, pending input, acknowledged receipts, accessory
chrome, visual-viewport placement, dismissal, and telemetry. A confirmed pointer tap primes only when
the mirrored remote cursor is `ibeam` or `unknown`; any other shape sends the click with no focus
correlation, so the helper never probes and the keyboard is never raised to be withdrawn. A prime
focuses the textarea synchronously, replaces any prior pending request, and waits at most 700 ms for
its correlated focus result. The Keyboard button is an explicit request and ignores the cursor gate.
Pending input is capped at 32 normalized events and is discarded on replacement,
timeout, rejection, channel close, revocation, or reconnect. Paste, dictation insertion, and composition
commit are prevalidated atomically. The last 64 acknowledged events form a non-editable receipt;
secure printable events become bullets and plaintext is not retained.

The accessory also shows an immediate, bounded local typing echo, separate from the acknowledged
receipt and delivery status. Backspace removes a local character and Return clears that local line;
neither action dismisses the keyboard. Secure or not-yet-classified targets use bullets. The capture
textarea retains a non-user sentinel so WebKit emits deletion even when the echo is empty. Native
`beforeinput` is bound directly, rather than React's text-only polyfill. The capture and accessory
are portaled to the document body so a blurred or clipped viewer toolbar cannot trap fixed positioning.
Viewport dismissal compares with the pre-keyboard height, not a concurrently shrinking layout viewport.

The video box ends at the accessory's top edge rather than running full height beneath it. That edge
is one measured number, the accessory's observed height plus its own offset from the layout viewport's
bottom, which covers the keyboard too because the accessory is drawn on top of it: the offset is zero
when the WKWebView's layout viewport has already shrunk to the keyboard-free area and the keyboard's
height when it has not, so the visible band is the same either way. The accessory's height is
measured, never assumed, because its bottom padding follows the safe area until the software
keyboard owns it.

Shortening the box alone would only move the problem: `object-contain` re-centres the picture in the
strip that is left, so the desktop shrinks and floats in black bars. While the keyboard occludes the
box the viewport instead covers it, scaling until both axes are filled and translating so the remote
cursor sits at the strip's centre, clamped so no content edge pulls inside the viewport. The view
held before the keyboard is restored when it leaves, because the cover is the viewer's decision and
not the user's. The viewport observes its own frame rather than the window, which never sees a box
the page shortened itself, and re-clamps the pan on every other resize, since a shorter box narrows
the legal pan range.
The keyboard chrome uses a 32 px echo field and one 36 px key rail with an inverted-T arrow cluster.
Auto and Hide sit in the echo line; acknowledged event history stays screen-reader-accessible without
a second visible receipt row. The software keyboard already owns the bottom safe area, so the web
accessory does not add that inset again. WebKit's native form toolbar is outside this page's authority:
the iOS desktop container opts out through `WKWebView.inputAccessoryView`, leaving the software keyboard
intact and the TypeScript rail as its only accessory. Other panels retain the system toolbar. This
shell change needs one client update; later keyboard behavior and chrome remain TypeScript-owned.

The sidecar validates and forwards canonical NDJSON, but does not translate key names or own keyboard
behavior. The latest intentional interaction acquires one Mac-wide ownership epoch, resets native
pointer state, and revokes the prior page. Frame kind 4 is the control-event frame and carries cursor,
focus, delivery, navigation, and native rejection events. Only cursor image, position, and the latest
display/Space snapshot are replayable to a new
channel. Key input, focus state, receipts, ownership, and pending events never replay.

#### Web Desktop and monitor navigation

The same ordered control-v2 channel carries `desktop-refresh`, exact-ID `space-select`, and
UUID-correlated `space-gesture` phases. Source metadata advertises `desktopNavigationVersion: 1`
and its stable `displayId`. Events report a revisioned `desktop-state` with each display's own
active Space, explicit unavailability, or a correlated posted/rejected result. Posting is not
settlement: the page waits for the target Space to become active, ignoring intermediate transitions,
and reports a bounded timeout. IDs remain UInt64 decimal strings, never JavaScript numbers (ADR-0112).

The compact TypeScript rail uses 40 by 30 px numbered pills in a 36 px expanded row, a 26 px collapsed
row, and an optional 32 px monitor row. Raw travel over half the rail or an agreeing flick above
800 points/sec commits; a short reverse flick cancels. Default finger-left selects next; the
TypeScript-owned Mac-direction toggle reverses swipes, never target taps. Explicit cancellation uses
Dock phase 8, not a zero-distance end. Two fingers, pointer-capture loss, blur, hidden page, ownership
loss, and topology changes retire the gesture. The rail hides while typing and reserves scroll-puck
clearance without changing video zoom. There are no thumbnails or window picker.

Navigation, its status messages, input-mode controls, and stream metadata form one bottom dock in
normal vertical flow. Safe-area padding belongs to that dock once. A ResizeObserver measures the
complete dock for scroll-puck clearance, including monitor rows and wrapped messages; navigation does
not guess a fixed offset above an independently positioned toolbar. Keyboard capture/accessory
portals remain outside the dock and video clipping.

The sidecar resolves main/explicit monitor aliases before encoder reuse. The helper captures exactly
that physical display and emits matching logical input bounds. A monitor handover keeps the old
image with input blocked, warms one candidate generation, and replaces the old source only after
the matching first presented frame. Stale candidate callbacks are ignored. Reconnect remains pinned
to that display. Unplug rehomes to the remaining main monitor with an explicit notice, including
when capture dies before sending a final topology event. Ordinary Desktop changes keep the stream,
pointer mode, and zoom. The standalone helper uses OS notifications, plus Mission-Control-scoped
exit checks; there is no idle topology polling. A changed monitor origin or extent retires its
capture so reconnection obtains fresh input bounds. Live acceptance reopens only the WebRTC stream after
the helper build, with neither app rebuilt or relaunched.

The standalone grid helper is the native capability boundary. It owns AX trust and focused-element
classification, I-beam sampling after an 80 ms probe plus an optional 160 ms settle, stable key-code
lookup, direct modifier flags, serial `CGEvent` key-down/key-up posting, pointer/scroll injection, and
explicit applied or rejected results. Accessibility denial rejects immediately and never falls through
to a cursor heuristic. Probe delays arrive through the bounded control channel so later tuning remains
TypeScript-only. Rebuilding this helper and reopening a stream does not rebuild or relaunch either app.

## Arena

An Arena run sends one prompt to several contestant sessions, each working in its own git worktree
of the target repository, and records what each one did. It never scores or ranks them: the reader
judges from the facts and the sessions (ADR-0127). The main decisions:

- **Isolation.** A contestant is confined to its worktree and six tools (ADR-0130), runs with the
  machine's own Claude setup (ADR-0138), and records what it reached outside its worktree
  (ADR-0139). A run is named and gets a repository of its own (ADR-0135). A plain folder named as
  the target is made a repository (ADR-0153), but the reader's own folder never is (ADR-0154).
- **Driving.** Claude contestants are driven through their sessions, and an opencode contestant is
  closed on its serve's marker (ADR-0128). A run can use terminal lanes beside headless ones, open
  before the prompt is sent (ADR-0133, ADR-0134), and a terminal run survives a sidecar restart
  (ADR-0137).
- **Reading.** The Arena tab shows contestants side by side in lanes (ADR-0129). A run may have a
  judge session (ADR-0140), which can act as a manager that plans lanes through the API (ADR-0141).
  A lane may argue against the prompt (ADR-0151), and a pass can send one lane's answer to the other
  side (ADR-0152).

## Group

Group, the group chat tab, is being built as its own server process in its own package,
`agent-feed/group/`, on Effect: the pilot for the rest of the sidecar (ADR-0155). Its entry point is
`src/GroupMain.ts`; its HTTP API is defined first as an Effect `HttpApi` contract (`src/api/`),
served under `/api/group/` with an OpenAPI document generated from it. It has its own compiler
settings, lint and tests, and imports nothing from the rest of the repository. The design, what is
decided and what is open, is `docs/plans/group-chat.md`. On 2026-10-25 it answers a health check
only, and neither the supervisor nor the panel reaches it yet.

## The messaging hub and questions for the owner

The messaging hub (`agent-feed/hub/`) passes messages between the owner and agent sessions on every
machine, and between sessions. It runs on a server the owner deploys, behind Cloudflare Access, and
each machine reaches it with its own service token, read from `~/.config/agentdesk-relay/hub.env`
(`AGENTDESK_HUB_ENV`). A Bot is the unit of address. The sidecar publishes this machine's Bots to
the hub (`src/messaging/hubBotPublisher.ts`). A Claude session reaches the hub through the
`agentdesk-relay` MCP server, registered once per machine, and receives messages through the
`agentdesk-hub` mod. An opencode session receives them through the serve
(`src/messaging/hubOpencode.ts`). The panel's Messages view shows each thread. Without `hub.env` the
sidecar logs `hub not configured` and does not publish any Bots. `docs/agent-messaging.md` has the
design and the setup.

`ask_owner`, from the `ask-owner` mod, is the other way an agent reaches the owner: the question
waits at `/api/asks` until someone answers it in the panel.

## Notifications, speech and audio

- **Web Push** (`src/push/`): a browser subscribes through `/api/push`, and subscriptions are kept
  in `web-push.json` beside `bots.json`. A push goes out when a Claude session in a Bot finishes its
  turn, read from the catalog's record of the transcript, and when a session waits on a question
  (`AGENT_FEED_PUSH_TURN_FINISHED`, `AGENT_FEED_PUSH_QUESTION_QUIET_MS`).
- **Speech** (experimental): the speech process speaks with Phonon on the Mac's GPU (ADR-0150). The
  sidecar sends it what a session says when its turn finishes, when it waits on a question, and
  again if that wait goes on (`src/push/sessionSpeech.ts`), and what a session asks to say itself
  (`POST /api/speech/say`, `tools/agent-radio-say.sh`). For now that speech goes to an
  experimental listening page (`packages/AgentPanel/Web/public/experiments/local-test.html?push=1`).
- **Agent Radio** (experimental): one AAC stream mixed in the audio process
  (`src/audio/audioStream.ts`, `packages/AgentPanel/Web/public/listen.html`). While the listening
  page's experiment is in the tree it takes over `/api/audio/speak`, so Agent Radio plays only its
  noise (recorded 2026-10-21), and `/api/audio/listeners`, which counts the listening pages instead
  (2026-10-24).

## Summaries, usage and background tasks

- **Summaries**: a Pi SDK session reads one turn and writes a digest of it
  (`src/summary/summaryRuntime.ts`), with the provider, model and key from
  `AGENT_FEED_SUMMARY_PROVIDER`, `AGENT_FEED_SUMMARY_MODEL` and `AGENT_FEED_SUMMARY_API_KEY`.
  Without the key the feature reports itself off.
- **Usage**: `src/usage/` sweeps each vendor's local records incrementally into a report
  (`/api/usage`), and streams the live rate-limit meters separately (`/api/limits`), because the two
  have different costs.
- **Background tasks**: a session's background tasks are read from the operating system's process
  table rather than from the agent (ADR-0099), with one probe for every watched session
  (`src/tasks/backgroundTaskCoordinator.ts`).

## Telemetry

The panel (`features/telemetry/`) and the sidecar (`src/telemetry/`) record page loads, Web Vitals,
each stream's first message, the sidecar's handling of every request a load made, errors and memory
samples, with Sentry's SDKs. The URL the SDKs report to is a placeholder on `telemetry.invalid`,
and both deliver to the sidecar, which keeps every envelope in an archive capped at 1 GB
(`/Users/Shared/agentdesk/logs/<user>-telemetry`, `AGENTDESK_TELEMETRY_ARCHIVE`). The SDKs do not
send anything to Sentry. `node tools/telemetry-replay.mjs` searches the archive, and a running
Spotlight receives a copy.

## The panel

`packages/AgentPanel/Web/src/` has four parts: `app/` (the shell, its state and the dev server's
plugins), `features/` (one directory per surface), `hooks/` and `query/`.

- **Surfaces.** `app/BrowserSurfaces.tsx` chooses between Desktop (the default), Feed and Screen,
  and the top bar adds Terminals, IDE, Arena and Branches. The Feed's sidebar has Canvas and
  Messages, beside the dormant Sessions and Bots views. A panel change is verified on a session card
  at `?entry=feed&view=canvas`.
- **Data.** Reads go through TanStack Query and through stores, and effects run only inside named
  hooks (ADR-0146). State shared across the tree lives in zustand and reaches the Canvas cards
  through context (ADR-0149). Live data that a widget shows lives in a store the widget reads.
- **Input.** The phone sends touch and the Mac sends a pointer, both to the same page, and the split
  that matters is `event.pointerType === "mouse"`. Behaviour meant for both belongs above that
  branch.
- **Containers.** The same code runs in a browser tab, in the Mac app's webview (live from the dev
  server, or bundled), and in the dormant iPhone app. It picks its transport by whether a native
  message handler is present.

`packages/AgentPanel/Web/AGENTS.md` has the panel's working rules: scroll direction, the two input
paths, the keyboard bar, what is remembered and where, attaching to elements, transient states, and
what an edit costs an open panel.

## Native pieces

- **The Mac app** (`host/`, Swift and AppKit, a menu-bar app) starts and supervises the sidecar and
  the panel's dev server at login, shows the panel in a webview, starts the PTY runtime, and has the
  Screen Recording and Accessibility permissions. Its QUIC session to the iPhone, its own video
  pipeline and its pairing are dormant. Its bundle ids are `AGENTDESK_BUNDLE_PREFIX` plus a fixed
  name, and without `AGENTDESK_APPLE_TEAM_ID` it is signed ad hoc.
- **The iPhone app** (`client/`) is dormant.
- **The Swift packages** in `packages/` serve the two native apps. `packages/AgentPanel/Web/` is the
  one directory there that is part of the current path.
- **The terminal runtime** (`terminal/`): `pty-vault` and `pty-manager` in Rust, a Swift client, the
  xterm.js fork, and a fork of `alacritty_terminal` that the manager parses with.
- **The capture and input helper** (`tools/grid-encoder/`) and **the virtual display**
  (`deskzoom/`), both Swift.

[dormant-native-design.md](dormant-native-design.md) has the native apps' requirements and design,
their wire shapes included, and [dormant-native.md](dormant-native.md) their operating detail.

## Repository gates

`just check` runs the checks for what a change touches and lists the legs it picked.
`just check-legs` runs every leg, and `just swift-check` builds and tests the native code, which
`just check` does not. The fitness checks in `tools/agent-feed-fitness.sh` enforce the rules that
apply to every change, among them: at most 500 lines per file, at most 12 source files per
directory, and imports by absolute path only, in `packages/AgentPanel/Web/src`,
`agent-feed/sidecar/src` and `agent-feed/group/src`; lint with oxlint (Group with its own); format with oxfmt at 120 columns; and personal data kept
out of the tree (`tools/public-scan/`). `main` reaches the public repository only through
`just publish`, which scans every commit it sends and refuses what is not a fast-forward, and a
pre-push hook refuses any other push there (`tools/publish.sh`, `tools/git-hooks/pre-push`). The
sidecar's tests run under `bun test --parallel` and the panel's under Vitest. Group's package
checks itself in a leg of its own with its own toolchain: typecheck, Effect's checks
(`@effect/tsgo`), lint, formatting and `bun test` (ADR-0156). A sidecar test waits
for what it expects, never for a length of time, and the lint gate refuses a timer in one.

## Cross-references

- Product intent: [PRD.md](PRD.md)
- Operating rules: [AGENTS.md](../AGENTS.md), and the notes under [agents/](agents/)
- Decisions: [architecture-decisions/](../architecture-decisions/)
- What is current and what is dormant: [FEATURE-MAP.md](../FEATURE-MAP.md)
- The trust model for a reader: [SECURITY.md](../SECURITY.md)
- The iteration ledger: [TASKS.md](TASKS.md), with retired ledgers in
  [tasks/archive/](tasks/archive/)
- The native apps: [dormant-native-design.md](dormant-native-design.md)
