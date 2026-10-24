# AgentDesk

AgentDesk is a web panel for running coding-agent sessions on a Mac and following them from the Mac
or a phone. Claude Code and opencode sessions run in tmux panes on the Mac. The panel shows each
session's transcript as the agent writes it, with a box to type into the session, and it also has
tabs for the Mac's terminals, a file editor and a live view of the Mac's screen.

> **AgentDesk is in active development.**
>
> - It is one developer's daily tool, published as it is used, and it does not have releases.
> - Its setup steps and file layout change without notice.
> - Several directories contain earlier approaches that are no longer used (see
>   [Parts of the tree that are not current](#parts-of-the-tree-that-are-not-current)).
> - The panel does not ask anyone to log in. Anyone who can reach it can run commands on the Mac
>   as you, so read [SECURITY.md](SECURITY.md) before you start it.

## The panel's tabs

The panel has seven tabs along its top bar:

- **Feed**, in its **Canvas** view, is where you read sessions and type into them. Each Bot (a
  name, a project folder, and the sessions working in that folder) shows its sessions as cards on
  the Canvas. A card shows its session's transcript and the questions the agent asks, which can be
  answered on the card, and has a box that types into the session.
- **Terminals** lists the Mac's tmux windows and panes and opens any of them.
- **IDE** browses a project folder's files, edits them, and searches them with ripgrep.
- **Desktop** streams one of the Mac's displays as video and sends it pointer and keyboard input.
  It needs the capture helper described under [Optional parts](#optional-parts).
- **Screen** shows the Mac through macOS Screen Sharing (VNC), which also works at the login
  window.
- **Arena** sends one prompt to several sessions, each in a git worktree of its own, and shows
  their answers side by side.
- **Branches** is the start of a view of one chat and the chats forked from it. For now it shows
  the same cards as Canvas.

## The panel, the sidecar and the sessions

Two processes on the Mac do the work: the panel's dev server and the sidecar. A browser loads the
panel from Vite's dev server, and the Mac app can also load a built copy of it. The sidecar is the
panel's backend: it starts sessions in tmux, reads their transcripts, and answers the panel's
`/api` requests. The dev server and the sidecar both run from source, so an edit to either one
reaches an open panel without a rebuild.

```
 browser on the Mac or a phone
        |
        |  http://127.0.0.1:5173                (loopback, the default)
        |  https://<mac>.<tailnet>.ts.net:5173   (tailnet mode)
        v
 panel dev server     packages/AgentPanel/Web     React, served by Vite
        |
        |  /api, forwarded to http://127.0.0.1:7682
        v
 sidecar              agent-feed/sidecar          TypeScript on Bun, under a supervisor
        |
        +-- tmux panes running claude and opencode
        +-- Claude Code transcripts in ~/.claude/projects (read only)
        +-- opencode serve, through its own HTTP API
```

The sidecar's supervisor restarts the sidecar when its source changes, and only once the changed
files parse and typecheck. The native pieces beside these two, the Mac app and a screen-capture
helper, are described under [Optional parts](#optional-parts), and the dormant iPhone app under
[Parts of the tree that are not current](#parts-of-the-tree-that-are-not-current).

## Requirements

The versions are the ones on the author's Mac on 2026-10-24. Older versions may work and have not
been tried.

| Tool | Version | Needed for |
| --- | --- | --- |
| macOS | 26.4, Apple silicon | everything |
| Xcode Command Line Tools | | `git`, `python3` and `swiftc` |
| [Bun](https://bun.sh) | 1.3.13 | the sidecar and the panel |
| [Node.js](https://nodejs.org) | 24.14 | the build scripts the recipes in `Justfile` run |
| [just](https://github.com/casey/just) | 1.50 | running the recipes in `Justfile` |
| [tmux](https://github.com/tmux/tmux) | 3.6b | every session runs in a tmux pane |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code), signed in | 2.1.310 | Claude sessions |
| [opencode](https://opencode.ai) | 2.0.30 | opencode sessions (optional) |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | 15.2 | search in the IDE tab (optional) |
| [Tailscale](https://tailscale.com) | 1.102 | the panel on a phone (optional) |

The sidecar looks for `tmux`, `claude` and `opencode` in `~/.local/bin`, `/opt/homebrew/bin` and
`/usr/local/bin`, and for opencode in `~/.opencode/bin` too. For a binary installed anywhere else,
set its path in `AGENT_FEED_TMUX_PATH`, `AGENT_FEED_CLAUDE_PATH` or `AGENT_FEED_OPENCODE_PATH`.

## First run

These steps start the panel and the sidecar for the Mac itself, at `127.0.0.1`. They do not need
the Mac app, Xcode or an Apple developer account.

1. Clone the repository and install the sidecar's packages:

   ```sh
   git clone https://github.com/nabinpkl/agent-desk.git
   cd agent-desk
   (cd agent-feed/sidecar && bun install --frozen-lockfile)
   ```

2. Start the sidecar in one terminal. It listens on `127.0.0.1:7682`:

   ```sh
   cd agent-feed/sidecar && bun src/supervisor.ts
   ```

   On a fresh Mac its log has a line for each part that is not set up:
   `opencode serve password is not configured`, `hub not configured`, and
   `not starting the speech process`. It also logs two `observer-connect-failed` lines every 30
   seconds. Those lines are its attempts to reach a proxy that mirrors Claude Code's network traffic,
   which is not part of this repository. The panel works without any of these four parts set up.

3. Start the panel's dev server in a second terminal, from the repository root. The first start
   installs the panel's packages:

   ```sh
   just agent-webview-dev
   ```

   It prints `agent-webview-dev: serving at http://127.0.0.1:5173 (loopback mode)`.

4. Open <http://127.0.0.1:5173/?entry=feed&view=canvas>. An empty Canvas shows "No bots yet".

5. Choose **Add Bot** and pick the Bot's project folder. The dialog's list shows the folders your
   agent sessions have already worked in, and **Browse folders** finds or creates any other.
   Adding the Bot starts its first session, Claude Code in a tmux pane, and the session appears on
   the Canvas as a card.

To stop, press Ctrl-C in both terminals. The tmux panes and the sessions in them keep running, and
the panel shows them again after the next start.

The panel's URL without `?entry=feed&view=canvas` opens the Desktop tab, which shows
"reconnecting" until the capture helper is installed.

### opencode sessions

The sidecar does not start opencode. It connects to an `opencode serve` that is already running on
the Mac, at `http://127.0.0.1:49374` by default (`AGENT_FEED_OPENCODE_URL`). It uses the password
that opencode writes to `~/.config/opencode/service.json` when opencode runs as a service:

```sh
opencode serve --service
```

Run one `opencode serve` per Mac. Every serve on a machine shares one SQLite database, and a second
serve fails with `database is locked`.

## The panel on a phone

`AGENTDESK_PANEL_LISTEN` sets where the panel can be reached from. Set it with a line in `.env` at
the repository root, for example `AGENTDESK_PANEL_LISTEN=tailnet`, and create the file if it is not
there.

| Value | Reachable from | URL |
| --- | --- | --- |
| `loopback` (the default) | the Mac only | `http://127.0.0.1:5173` |
| `tailnet` | the Mac and the devices on your tailnet | `https://<mac>.<tailnet>.ts.net:5173`, over HTTP/2 |
| `network` | every network the Mac is on | `http://<mac>.local:5173`, plain HTTP |

For a phone, use `tailnet`. It needs Tailscale running on the Mac and on the phone, with MagicDNS
and HTTPS certificates turned on for the tailnet. `just agent-webview-dev` then gets a certificate
for the Mac's Tailscale name and prints the `https://` URL to open on the phone.

The sidecar stays on loopback in every mode: a phone reaches it through the panel's dev server,
which forwards `/api` to it. `network` mode sends everything in plain HTTP to anyone on the
network, so use it only on a network you trust.

## Configuration

Every setting is an environment variable. The recipes in `Justfile`, `just agent-webview-dev`
among them, also read `.env` at the repository root, which is gitignored. `.env.example` lists the
settings with comments. Copy only the lines you need from it: some of its values are examples or
lists of choices, and it turns on `AGENTDESK_AUTO_APPROVE`, a development setting described in
[SECURITY.md](SECURITY.md). A sidecar started from a terminal as in the first run reads only its own
environment, so its settings go on its command line, for example
`AGENT_FEED_PORT=7700 bun src/supervisor.ts`. It reads them once, when it starts.

These are the settings a first run is most likely to change:

| Variable | Read by | Default | What it sets |
| --- | --- | --- | --- |
| `AGENTDESK_PANEL_LISTEN` | panel | `loopback` | where the panel can be reached from (see above) |
| `AGENTDESK_AGENT_PANEL_DEV_PORT` | panel | `5173` | the panel's port |
| `AGENT_FEED_PORT` | sidecar | `7682` | the sidecar's port. A sidecar on another port needs the panel told: `just agent-webview-dev 5173 http://127.0.0.1:7700` |
| `AGENT_FEED_CLAUDE_PERMISSION_MODE` | sidecar | `auto` | the permission mode a Claude session starts in: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk` or `plan` |
| `AGENT_FEED_CLAUDE_ALLOW_BYPASS` | sidecar | `true` | whether "bypass permissions" is one of the modes Shift+Tab cycles through in a session |
| `AGENT_FEED_IDLE_CLOSE_AFTER_MS` | sidecar | two hours | how long a Claude or opencode session that is not on any Bot can sit idle before the sidecar closes its tmux pane; `0` turns this off |

The sidecar keeps its state in `~/Library/Application Support/agentdesk-agent-feed/` and in the
runtime folder `~/Library/Application Support/AgentDeskRuntime/` (`AGENTDESK_RUNTIME_ROOT`). Each
running sidecar also writes a file describing itself to `/Users/Shared/agentdesk/sidecars/`
(`AGENTDESK_SIDECAR_REGISTRY`), where the panel and other sidecars find it.

## Optional parts

Each part below is set up separately, after the first run works. The author uses all of them on
one Mac, and their setup has not yet been tried on a second one.

- **Desktop tab.** `just grid-encoder-install` builds the Swift capture and input helper
  (`tools/grid-encoder/`) and installs it in the runtime folder. Capturing the screen needs macOS's
  Screen Recording permission, and sending input needs Accessibility, both granted to the app that
  starts the sidecar. On the author's Mac that app is the Mac app below, which has both. A sidecar
  started from a terminal there did not have Screen Recording permission, and window capture came
  back "not shareable". Granting a terminal app Screen Recording for this has not been tried.
- **Screen tab.** Turn on Screen Sharing in System Settings, under General, Sharing. The panel's
  dev server relays the page to it on `127.0.0.1:5900`, and Screen Sharing asks for a macOS
  account's name and password.
- **The Mac app** (`host/`) starts and supervises the sidecar and the panel's dev server at login,
  and has the Screen Recording and Accessibility permissions. `just host-run` builds and launches
  it. Without an Apple developer team it is signed ad hoc, and macOS asks for its permissions again
  after each rebuild. `AGENTDESK_BUNDLE_PREFIX` and `AGENTDESK_APPLE_TEAM_ID` in `.env` give it a
  stable identity. `docs/agents/dev-loop.md` describes how it starts the other pieces.
- **Voice.** `just speech-voice` installs the speech process's Python environment and voice model.
  The speech process reads events aloud, such as a session finishing a turn, to a listening page
  that is still an experiment.
- **A second machine.** Run `just remote-sidecar-setup <ssh host>` once, then
  `just remote-sidecar-run <ssh host>`, to run a sidecar on another macOS or Linux machine over
  ssh, bound to that machine's tailnet address. `AGENTDESK_PANEL_REMOTE_SIDECARS` in `.env` adds its
  sessions to the panel.
- **Agent messaging.** A hub (`agent-feed/hub/`) passes messages between you and the
  sessions on the Mac and on a second machine. `docs/agent-messaging.md` describes it, and
  `agent-feed/hub/deploy/` has the files for deploying it to a server of your own.
- **Annotator.** `agentdesk-annotator/` is a Chrome extension and server for leaving notes on parts
  of a web page, which agents then read through MCP tools. Its own `README.md` covers deploying it.

## Parts of the tree that are not current

Several approaches to the same problem are checked in at once, and the code does not show which
one is in use. [FEATURE-MAP.md](FEATURE-MAP.md) records which directories are current, and
`git log` on a directory shows when it was last worked on. The main parts that are not current are
these:

- **The iPhone app** (`client/`) and the Mac app's own video pipeline to it are dormant. On a phone,
  the panel runs in a browser.
- **Codex and Pi** are still wired in as session sources and still list their sessions, but
  sessions no longer run in Codex or Pi. The Pi SDK still writes the panel's turn summaries.
- **The Sessions and Bots views** of the Feed tab are dormant, replaced by Canvas.
- **Voice input, browser projection and the DOM mirror** (`gesture-agent/`, `voice-assets/`,
  `chrome-extension/`, `dom-bridge/`, `packages/BrowserProjection/` and others) are dormant.
- `PRD.md` and `SPEC.md` describe the native iPhone and Mac apps the project started as.
  `HANDOVER.md`, `TASKS.md` and `tasks/` are working notes from earlier stretches of work.

## Repository layout

| Path | Contents |
| --- | --- |
| `packages/AgentPanel/Web/` | the panel: React, Vite, Tailwind |
| `agent-feed/sidecar/` | the sidecar, its supervisor, and the Claude Code plugins it loads into sessions (`mods/`) |
| `agent-feed/wire/` | the request and response shapes the panel and the sidecar share |
| `agent-feed/hub/`, `agent-feed/speech/` | the messaging hub and the speech process |
| `tools/` | build and launch scripts, the capture helper, and the repository's checks |
| `host/`, `client/`, `packages/`, `terminal/`, `deskzoom/` | the native Mac and iPhone apps, their Swift packages, the Rust terminal runtime, and a virtual display |
| `architecture-decisions/` | one numbered record per decision |
| `docs/` | how-to notes, most of them under `docs/agents/` |

## Development

`just check` runs the checks for the parts of the tree a change touches (tests, typecheck, lint,
formatting and the repository's own fitness checks) and lists the ones it picked.
`just check-legs` runs all of them. `just git-hooks-install` installs the repository's pre-commit
hook. `AGENTS.md` and the notes under `docs/agents/` are the working rules for anyone changing the code,
coding agents included.

## License

AgentDesk is released under the [MIT License](LICENSE). Code from other projects that is checked
into this repository keeps its own license, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
lists each one.
