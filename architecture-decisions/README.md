# Architecture Decision Records

One file per architectural decision. Append-only log; once an ADR is accepted, do not edit its conclusions. Write a new ADR that supersedes it.

## What an ADR is for

An ADR captures a choice that:

- changes a load-bearing piece of the architecture (storage backend, framework, protocol, transport),
- locks in a non-obvious tradeoff that would otherwise have to be re-derived weeks later,
- closes off a path that someone reading the code six months from now might reasonably try to reopen.

Skip ADRs for: renames, dependency bumps, bug fixes, minor refactors, anything inferable from reading the code.

## File naming

`NNNN-kebab-case-title.md`. Four-digit zero-padded, monotonically increasing. Numbers are never reused; if an ADR is dropped before acceptance, retire its number in the index with status `dropped`.

The number is the stable handle. Cross-references from `TASKS.md` and code comments use `ADR-NNNN`, never the path.

## Status lifecycle

Set in YAML frontmatter at the top of the file.

- `proposed`: written, open for discussion. The only state in which an ADR is freely edited.
- `accepted`: committed. The ADR is now immutable. Corrections to typos and link rot are fine; conclusions and consequences are not edited.
- `deprecated`: no longer applies, no replacement.
- `superseded by ADR-NNNN`: replaced by a newer ADR. Both ADRs cross-link.

If a decision needs to change, write a new ADR that supersedes the previous one and add `supersedes: ADR-NNNN` to the new ADR's frontmatter and `superseded-by: ADR-NNNN` to the old one's. The log preserves the history of the thinking, not just the latest position.

## How to add one

1. Copy `TEMPLATE.md` to the next available `NNNN-your-title.md`.
2. Fill in Context, Decision Drivers, Considered Options, Decision Outcome, Consequences. Skip the Confirmation and Pros and Cons sections if they do not earn their place.
3. Set `status: proposed` and today's date.
4. Open the change. When merged with `status: accepted`, add a row to the index below.
5. Reference the ADR from `TASKS.md` and code comments as `ADR-NNNN`.

## Template provenance

`TEMPLATE.md` follows MADR 4.0 (https://adr.github.io/madr/, released 2024-09-17) with trims for a solo workflow: team-RACI metadata is dropped, `More Information` is folded into `Links`, `Pros and Cons of the Options` is optional and only filled when the choice is close.

## Index

| ID       | Title                                                                                                             | Status                           | Date       |
| -------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------- |
| ADR-0001 | AgentDesk v0 stack and transport                                                                                  | accepted                         | 2026-05-20 |
| ADR-0002 | Pairing crypto for v0                                                                                             | accepted                         | 2026-05-20 |
| ADR-0003 | Session establishment for v0                                                                                      | accepted                         | 2026-05-20 |
| ADR-0004 | Media transport seams for v0                                                                                      | superseded by ADR-0015           | 2026-05-20 |
| ADR-0005 | Input channel separation                                                                                          | accepted                         | 2026-05-22 |
| ADR-0006 | Spaces thumbnail capture for the iPhone preview strip                                                             | proposed                         | 2026-05-23 |
| ADR-0007 | Host-side viewport crop for zoom sharpness                                                                        | superseded by ADR-0008           | 2026-05-23 |
| ADR-0008 | Native-pixel encoder density, local-only zoom                                                                     | proposed                         | 2026-05-23 |
| ADR-0009 | Cursor-driven viewport pan (edge follow)                                                                          | proposed                         | 2026-05-23 |
| ADR-0010 | Host-side push-to-talk dictation                                                                                  | proposed                         | 2026-05-28 |
| ADR-0011 | Session-bound input channel authentication                                                                        | accepted                         | 2026-05-31 |
| ADR-0012 | Owned media transport control and reuse map                                                                       | superseded by ADR-0013           | 2026-06-18 |
| ADR-0013 | Single-surface UDP owned media                                                                                    | superseded by ADR-0014           | 2026-06-18 |
| ADR-0014 | QUIC datagram owned media                                                                                         | superseded by ADR-0015           | 2026-06-18 |
| ADR-0015 | Owned single-surface media                                                                                        | superseded by ADR-0016           | 2026-06-19 |
| ADR-0016 | Scroll-first hybrid retained graphics                                                                             | accepted                         | 2026-06-20 |
| ADR-0019 | Mac-initiated tailnet pairing with a host-side device picker                                                      | proposed                         | 2026-06-22 |
| ADR-0020 | Wire protocol version negotiated at the session handshake                                                         | proposed                         | 2026-06-22 |
| ADR-0021 | Damage-driven retained graphics                                                                                   | superseded by ADR-0022           | 2026-06-22 |
| ADR-0022 | Multi-stream QUIC and progressive repaint, dropping pixel-guessed scroll                                          | partially superseded by ADR-0025 | 2026-06-25 |
| ADR-0023 | Revive a hardened, host-detected scroll copyRect                                                                  | superseded by ADR-0024           | 2026-06-25 |
| ADR-0024 | Predict-and-correct scroll (motion plus residual)                                                                 | superseded by ADR-0025           | 2026-06-25 |
| ADR-0025 | Mixed-mode renderer: hardware HEVC video for motion, retained tiles for rest                                      | accepted                         | 2026-06-25 |
| ADR-0026 | Video-primary owned media: retire the reliable channel                                                            | proposed                         | 2026-06-26 |
| ADR-0027 | Congestion-adaptive video for constrained links                                                                   | accepted                         | 2026-06-26 |
| ADR-0028 | Selective packet resend (NACK) and bounded keyframe recovery                                                      | superseded by ADR-0073           | 2026-06-26 |
| ADR-0029 | Capacity survival rung: trade frame rate and bitrate for a slow link                                              | proposed                         | 2026-06-26 |
| ADR-0030 | Single QUIC session transport for v0                                                                              | accepted                         | 2026-06-27 |
| ADR-0031 | Selected display projection on the client                                                                         | accepted                         | 2026-06-27 |
| ADR-0032 | Durable client diagnostics                                                                                        | partially superseded by ADR-0070 | 2026-06-27 |
| ADR-0033 | Adaptive media quality ladder                                                                                     | proposed                         | 2026-06-28 |
| ADR-0034 | Motion-region crisp-repair: revive tiles at rest as a per-region sharpen over video                               | proposed                         | 2026-06-28 |
| ADR-0035 | Phone-side agent-feed observability surface fed by an embedded engine sidecar                                     | superseded by ADR-0074           | 2026-06-30 |
| ADR-0036 | Crisp observe is damage-gated with a periodic full-surface heal                                                   | partially superseded by ADR-0105 | 2026-07-01 |
| ADR-0037 | Host identity is the bundle id; dev and stable hosts are concurrent variants                                      | accepted                         | 2026-07-01 |
| ADR-0038 | Mirror Chrome DOM over a dedicated reliable QUIC lane instead of pixels                                           | superseded by ADR-0042           | 2026-07-01 |
| ADR-0039 | Bridge Chrome to the host through a sacrificial native-messaging shim                                             | proposed                         | 2026-07-01 |
| ADR-0040 | Route phone taps back to Chrome as trusted input via chrome.debugger                                              | proposed                         | 2026-07-01 |
| ADR-0041 | DOM-mirror password masking, pixel fallback, asset reachability, data audit                                       | proposed                         | 2026-07-01 |
| ADR-0042 | Run the DOM recorder in the extension's isolated world, triggered from the chrome layer                           | proposed                         | 2026-07-01 |
| ADR-0043 | Compress DOM-mirror batches end-to-end, snapshot as a rare keyframe, chunk as a backstop                          | proposed                         | 2026-07-01 |
| ADR-0044 | Tiered DOM-mirror fidelity: isolated adopted-stylesheet enrichment + opt-in CDP keyframe (no MAIN world)          | proposed                         | 2026-07-01 |
| ADR-0048 | Host-side mobile device emulation for the DOM mirror                                                              | superseded by ADR-0065           | 2026-07-02 |
| ADR-0050 | Shared wire types as a local Swift package, and modern synchronized Xcode project format                          | accepted                         | 2026-07-03 |
| ADR-0051 | Remote SwiftTerm terminal over the Agent Workspace IDE PTY multiplexer                                            | superseded by ADR-0053           | 2026-07-06 |
| ADR-0052 | AgentDesk owns the agent workspace                                                                                | accepted                         | 2026-07-10 |
| ADR-0053 | AgentDesk owns the terminal PTY packages                                                                          | accepted                         | 2026-07-10 |
| ADR-0054 | Share the workspace+files data model; port the agent-workspace-ide shell                                          | accepted                         | 2026-07-11 |
| ADR-0055 | Port the dock-enrichment strip, backed by a single SkyLight source                                                | accepted                         | 2026-07-12 |
| ADR-0056 | Bottom Agent Panel terminal                                                                                       | superseded by ADR-0108           | 2026-07-13 |
| ADR-0057 | Shared responsive DOCX preview over the Files stream                                                              | accepted                         | 2026-07-16 |
| ADR-0058 | Sequenced cursor reconciliation with explicit host provenance                                                     | accepted                         | 2026-07-16 |
| ADR-0059 | Swap Dock desktop contents through yabai                                                                          | accepted                         | 2026-07-17 |
| ADR-0060 | Fragment large Agent feed raw events on the input lane                                                            | accepted                         | 2026-07-18 |
| ADR-0061 | Compose the iOS workspace as resizable panes with a host-resolved terminal                                        | accepted                         | 2026-07-19 |
| ADR-0062 | Embed one responsive workspace IDE in two native pane shells                                                      | accepted                         | 2026-07-19 |
| ADR-0063 | Project all Chrome windows through one local recorder                                                             | superseded by ADR-0064           | 2026-07-20 |
| ADR-0064 | Project the full Chrome hierarchy to iOS                                                                          | accepted                         | 2026-07-21 |
| ADR-0065 | Let the last active Browser viewer own Chrome's projected viewport                                                | accepted                         | 2026-07-21 |
| ADR-0066 | Let the persistent PTY manager own bounded terminal replay                                                        | partially superseded by ADR-0068 | 2026-07-22 |
| ADR-0067 | Crop terminal viewports below a readable scale                                                                    | partially superseded by ADR-0068 | 2026-07-22 |
| ADR-0068 | Let the last active terminal viewer own the source grid size                                                      | accepted                         | 2026-07-22 |
| ADR-0069 | Share one web terminal workspace across macOS and iOS                                                             | accepted                         | 2026-07-22 |
| ADR-0070 | Capture paired-client screenshots on demand                                                                       | accepted                         | 2026-07-22 |
| ADR-0071 | Reconcile workspace assignments after Mission Control                                                             | accepted                         | 2026-07-23 |
| ADR-0072 | Centralize PTY descriptor custody with live handover                                                              | partially superseded by ADR-0080 | 2026-07-23 |
| ADR-0073 | Freshness-first owned media drops obsolete frames instead of waiting for ACKs                                     | accepted                         | 2026-07-23 |
| ADR-0074 | Own the agent feed source inside AgentDesk                                                                        | superseded by ADR-0075           | 2026-07-24 |
| ADR-0075 | Load the agent feed by visible layer                                                                              | accepted                         | 2026-07-24 |
| ADR-0076 | Let the Mac host own shared voice recordings and analysis                                                         | accepted                         | 2026-07-27 |
| ADR-0077 | Build the workspace IDE surface on Vite, TypeScript and Tailwind, and defer React                                 | accepted                         | 2026-07-27 |
| ADR-0078 | A PTY session lives as long as its process, and only an explicit act ends it                                      | accepted                         | 2026-07-27 |
| ADR-0079 | Let the shared web voice session own macOS dictation audio                                                        | accepted                         | 2026-07-27 |
| ADR-0080 | A code update never ends a PTY session                                                                            | accepted                         | 2026-07-27 |
| ADR-0081 | Let the containing app own keyboard dictation capture                                                             | accepted                         | 2026-07-28 |
| ADR-0082 | Prewarm host Whisper when the voice sidecar starts                                                                | accepted                         | 2026-07-29 |
| ADR-0083 | Prewarm host Kokoro when the voice sidecar starts                                                                 | partially superseded by ADR-0084 | 2026-07-29 |
| ADR-0084 | Separate reference cache access from Kokoro model serialization                                                   | accepted                         | 2026-07-29 |
| ADR-0085 | Make practice passages the shared Voice library authority                                                         | accepted                         | 2026-07-30 |
| ADR-0086 | Give the agent feed two views, with the raw one as the fidelity guarantee                                         | accepted                         | 2026-07-30 |
| ADR-0091 | Own live agent sessions behind provider-neutral backends                                                          | accepted                         | 2026-08-01 |
| ADR-0092 | Restore every standalone tool window through one Desktop placement authority                                      | accepted                         | 2026-08-02 |
| ADR-0105 | The crisp window keeps its own clock                                                                              | accepted                         | 2026-08-19 |
| ADR-0106 | One supervisor owns the dial                                                                                      | accepted                         | 2026-08-19 |
| ADR-0093 | Let the DOM declare the window drag region                                                                        | accepted                         | 2026-08-04 |
| ADR-0094 | Stream and drive one window instead of the whole Desktop                                                          | accepted                         | 2026-08-07 |
| ADR-0095 | Relay the agent feed instead of restating it in Swift                                                             | accepted                         | 2026-08-11 |
| ADR-0096 | Serve the dev panel over the tailnet's TLS name, so the phone gets HMR too                                        | accepted                         | 2026-08-11 |
| ADR-0097 | List a project's sessions from the catalog index, never from transcript bodies                                    | accepted                         | 2026-08-13 |
| ADR-0098 | Rate-match the media path to the link                                                                             | accepted                         | 2026-08-13 |
| ADR-0099 | Observe an agent's background tasks from the OS, and stream their output on demand                                | proposed                         | 2026-08-14 |
| ADR-0100 | A keyframe is a session-start event, not a runtime one                                                            | proposed                         | 2026-08-15 |
| ADR-0107 | Address a CLI session by its inbox, not its window                                                                | superseded by ADR-0142           | 2026-08-20 |
| ADR-0108 | Render agent terminals inside the Agent Feed                                                                      | proposed                         | 2026-08-26 |
| ADR-0109 | Own first-party WebView desktop control in TypeScript                                                             | accepted                         | 2026-08-27 |
| ADR-0110 | Own the Claude and Codex window composers in TypeScript                                                           | accepted                         | 2026-08-27 |
| ADR-0111 | Drive the composer and the feed from events, and name the one place that cannot be                                | accepted                         | 2026-08-27 |
| ADR-0112 | Navigate Desktops through the Web control channel                                                                 | accepted                         | 2026-08-27 |
| ADR-0113 | Install the local runtime outside disposable build output                                                         | accepted                         | 2026-08-28 |
| ADR-0114 | Keep the panel's remembered UI state in one store, and persist only what a reader arranged                        | proposed                         | 2026-09-07 |
| ADR-0115 | Serve the workspace IDE from the Agent Panel and the sidecar                                                      | accepted                         | 2026-09-10 |
| ADR-0116 | Opencode sessions join the feed as a backend, not a transcript                                                    | accepted                         | 2026-09-22 |
| ADR-0117 | Terminals list windows and panes, addressed the way tmux addresses them                                           | accepted                         | 2026-09-23 |
| ADR-0118 | Terminal wall tiles follow the pane and never resize it                                                           | accepted                         | 2026-09-23 |
| ADR-0119 | Claude sessions hand over to opencode as one rendered prompt                                                      | accepted                         | 2026-09-23 |
| ADR-0120 | Opencode sessions get the thread terminal Claude sessions have                                                    | accepted                         | 2026-09-24 |
| ADR-0121 | Opencode session pane resumes onto its session                                                                    | accepted                         | 2026-09-25 |
| ADR-0122 | Opencode sessions hand over to Claude as one first-turn argv                                                      | accepted                         | 2026-09-28 |
| ADR-0123 | The IDE's file and text search run on ripgrep, over one scope                                                     | accepted                         | 2026-09-30 |
| ADR-0124 | A transcript row is named by the byte its line starts at                                                          | accepted                         | 2026-10-04 |
| ADR-0125 | A thread holds ranges of its transcript, and seeks to a position instead of paging to it                          | accepted                         | 2026-10-05 |
| ADR-0126 | Archiving a session is ours, kept per machine beside bots.json                                                    | accepted                         | 2026-10-11 |
| ADR-0127 | Arena runs fan one prompt out to worktree contestants, recording facts and judging nothing                        | accepted                         | 2026-10-11 |
| ADR-0128 | Arena contestants run behind one driver seam; Claude is spawned, opencode closes on the serve's own marker        | accepted                         | 2026-10-11 |
| ADR-0129 | The arena tab reads contestants side by side in lanes, each lane the existing SessionView                         | accepted                         | 2026-10-11 |
| ADR-0130 | Arena contestants are confined to their worktree and the same six tools, on both harnesses                        | accepted                         | 2026-10-12 |
| ADR-0131 | An arena opencode session holds its confining rules from the create request itself                                | accepted                         | 2026-10-12 |
| ADR-0132 | The sidecar talks to opencode through the serve's own client, pinned to the serve's release                       | accepted                         | 2026-10-12 |
| ADR-0133 | Arena runs drive their contestants as terminal sessions, beside the headless mode                                 | accepted                         | 2026-10-12 |
| ADR-0134 | A terminals arena run opens its lanes before it has a prompt                                                      | accepted                         | 2026-10-13 |
| ADR-0135 | Arena runs are named, live in a folder in the arena home, and get a repository of their own                       | accepted                         | 2026-10-13 |
| ADR-0136 | A Claude contestant's Write is confined by its Edit rule, with no Write rule of its own                           | accepted                         | 2026-10-13 |
| ADR-0137 | A terminals arena run survives a sidecar restart                                                                  | accepted                         | 2026-10-13 |
| ADR-0138 | A Claude contestant runs with this machine's own setup, without `--safe-mode`                                     | accepted                         | 2026-10-13 |
| ADR-0139 | Arena contestants run as plain agents, and the arena records what each reached outside its worktree               | accepted                         | 2026-10-13 |
| ADR-0140 | An arena run may have a judge: a read-only session in a pane, briefed by the sidecar, prompted only by the reader | superseded by ADR-0141           | 2026-10-13 |
| ADR-0141 | The arena's judge becomes its manager, which plans the lanes and runs them through the arena's own API            | accepted                         | 2026-10-16 |
| ADR-0142 | The composer stops typing into a CLI session through its messaging socket                                         | accepted                         | 2026-10-17 |
| ADR-0143 | A Claude session can run through the Agent SDK, in a runner held by its tmux pane                                 | accepted                         | 2026-10-17 |
| ADR-0144 | An SDK session's runner is a pipe, and a stale one relaunches with resume when idle                               | accepted                         | 2026-10-18 |
| ADR-0145 | A Claude session resumes with the model, effort and permission mode it last ran with                              | accepted                         | 2026-10-18 |
| ADR-0146 | The panel reads data through queries and stores, and bans effects outside named hooks                             | accepted                         | 2026-10-18 |
| ADR-0147 | A role session registers its agent log with the sidecar, found through the rendezvous board                       | accepted                         | 2026-10-19 |
| ADR-0148 | Agent Radio speaks audio the Mac makes, pushed to the phone and mixed there                                       | proposed                         | 2026-10-20 |
| ADR-0149 | Panel state shared across the tree lives in zustand, and reaches the canvas cards through context                  | accepted                         | 2026-10-20 |
| ADR-0150 | The speech process speaks with Phonon, streamed from the Mac's GPU                                               | accepted                         | 2026-10-22 |
| ADR-0151 | An arena lane may argue against the prompt instead of doing it                                                   | accepted                         | 2026-10-23 |
| ADR-0152 | An arena pass sends one lane's answer to a lane on the other side                                                | accepted                         | 2026-10-23 |
| ADR-0153 | An arena run may name a plain folder, which it makes a repository                                                | superseded by ADR-0154           | 2026-10-23 |
| ADR-0154 | An arena run never makes a repository of the reader's folder; the reader asks for one                            | accepted                         | 2026-10-23 |
| ADR-0155 | Group is its own package, the pilot for Effect, with its own compiler settings, lint and tests                   | accepted                         | 2026-10-25 |
