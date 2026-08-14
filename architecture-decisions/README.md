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

| ID | Title | Status | Date |
| --- | --- | --- | --- |
| ADR-0001 | AgentDesk v0 stack and transport | accepted | 2026-05-20 |
| ADR-0002 | Pairing crypto for v0 | accepted | 2026-05-20 |
| ADR-0003 | Session establishment for v0 | accepted | 2026-05-20 |
| ADR-0004 | Media transport seams for v0 | superseded by ADR-0015 | 2026-05-20 |
| ADR-0005 | Input channel separation | accepted | 2026-05-22 |
| ADR-0006 | Spaces thumbnail capture for the iPhone preview strip | proposed | 2026-05-23 |
| ADR-0007 | Host-side viewport crop for zoom sharpness | superseded by ADR-0008 | 2026-05-23 |
| ADR-0008 | Native-pixel encoder density, local-only zoom | proposed | 2026-05-23 |
| ADR-0009 | Cursor-driven viewport pan (edge follow) | proposed | 2026-05-23 |
| ADR-0010 | Host-side push-to-talk dictation | proposed | 2026-05-28 |
| ADR-0011 | Session-bound input channel authentication | accepted | 2026-05-31 |
| ADR-0012 | Owned media transport control and reuse map | superseded by ADR-0013 | 2026-06-18 |
| ADR-0013 | Single-surface UDP owned media | superseded by ADR-0014 | 2026-06-18 |
| ADR-0014 | QUIC datagram owned media | superseded by ADR-0015 | 2026-06-18 |
| ADR-0015 | Owned single-surface media | superseded by ADR-0016 | 2026-06-19 |
| ADR-0016 | Scroll-first hybrid retained graphics | accepted | 2026-06-20 |
| ADR-0019 | Mac-initiated tailnet pairing with a host-side device picker | proposed | 2026-06-22 |
| ADR-0020 | Wire protocol version negotiated at the session handshake | proposed | 2026-06-22 |
| ADR-0021 | Damage-driven retained graphics | superseded by ADR-0022 | 2026-06-22 |
| ADR-0022 | Multi-stream QUIC and progressive repaint, dropping pixel-guessed scroll | partially superseded by ADR-0025 | 2026-06-25 |
| ADR-0023 | Revive a hardened, host-detected scroll copyRect | superseded by ADR-0024 | 2026-06-25 |
| ADR-0024 | Predict-and-correct scroll (motion plus residual) | superseded by ADR-0025 | 2026-06-25 |
| ADR-0025 | Mixed-mode renderer: hardware HEVC video for motion, retained tiles for rest | accepted | 2026-06-25 |
| ADR-0026 | Video-primary owned media: retire the reliable channel | proposed | 2026-06-26 |
| ADR-0027 | Congestion-adaptive video for constrained links | accepted | 2026-06-26 |
| ADR-0028 | Selective packet resend (NACK) and bounded keyframe recovery | superseded by ADR-0073 | 2026-06-26 |
| ADR-0029 | Capacity survival rung: trade frame rate and bitrate for a slow link | proposed | 2026-06-26 |
| ADR-0030 | Single QUIC session transport for v0 | accepted | 2026-06-27 |
| ADR-0031 | Selected display projection on the client | accepted | 2026-06-27 |
| ADR-0032 | Durable client diagnostics | partially superseded by ADR-0070 | 2026-06-27 |
| ADR-0033 | Adaptive media quality ladder | proposed | 2026-06-28 |
| ADR-0034 | Motion-region crisp-repair: revive tiles at rest as a per-region sharpen over video | proposed | 2026-06-28 |
| ADR-0035 | Phone-side agent-feed observability surface fed by an embedded engine sidecar | superseded by ADR-0074 | 2026-06-30 |
| ADR-0036 | Crisp observe is damage-gated with a periodic full-surface heal | accepted | 2026-07-01 |
| ADR-0037 | Host identity is the bundle id; dev and stable hosts are concurrent variants | accepted | 2026-07-01 |
| ADR-0038 | Mirror Chrome DOM over a dedicated reliable QUIC lane instead of pixels | superseded by ADR-0042 | 2026-07-01 |
| ADR-0039 | Bridge Chrome to the host through a sacrificial native-messaging shim | proposed | 2026-07-01 |
| ADR-0040 | Route phone taps back to Chrome as trusted input via chrome.debugger | proposed | 2026-07-01 |
| ADR-0041 | DOM-mirror password masking, pixel fallback, asset reachability, data audit | proposed | 2026-07-01 |
| ADR-0042 | Run the DOM recorder in the extension's isolated world, triggered from the chrome layer | proposed | 2026-07-01 |
| ADR-0043 | Compress DOM-mirror batches end-to-end, snapshot as a rare keyframe, chunk as a backstop | proposed | 2026-07-01 |
| ADR-0044 | Tiered DOM-mirror fidelity: isolated adopted-stylesheet enrichment + opt-in CDP keyframe (no MAIN world) | proposed | 2026-07-01 |
| ADR-0048 | Host-side mobile device emulation for the DOM mirror | superseded by ADR-0065 | 2026-07-02 |
| ADR-0050 | Shared wire types as a local Swift package, and modern synchronized Xcode project format | accepted | 2026-07-03 |
| ADR-0051 | Remote SwiftTerm terminal over the Agent Workspace IDE PTY multiplexer | superseded by ADR-0053 | 2026-07-06 |
| ADR-0052 | AgentDesk owns the agent workspace | accepted | 2026-07-10 |
| ADR-0053 | AgentDesk owns the terminal PTY packages | accepted | 2026-07-10 |
| ADR-0054 | Share the workspace+files data model; port the agent-workspace-ide shell | accepted | 2026-07-11 |
| ADR-0055 | Port the dock-enrichment strip, backed by a single SkyLight source | accepted | 2026-07-12 |
| ADR-0056 | Bottom Agent Panel terminal | accepted | 2026-07-13 |
| ADR-0057 | Shared responsive DOCX preview over the Files stream | accepted | 2026-07-16 |
| ADR-0058 | Sequenced cursor reconciliation with explicit host provenance | accepted | 2026-07-16 |
| ADR-0059 | Swap Dock desktop contents through yabai | accepted | 2026-07-17 |
| ADR-0060 | Fragment large Agent feed raw events on the input lane | accepted | 2026-07-18 |
| ADR-0061 | Compose the iOS workspace as resizable panes with a host-resolved terminal | accepted | 2026-07-19 |
| ADR-0062 | Embed one responsive workspace IDE in two native pane shells | accepted | 2026-07-19 |
| ADR-0063 | Project all Chrome windows through one local recorder | superseded by ADR-0064 | 2026-07-20 |
| ADR-0064 | Project the full Chrome hierarchy to iOS | accepted | 2026-07-21 |
| ADR-0065 | Let the last active Browser viewer own Chrome's projected viewport | accepted | 2026-07-21 |
| ADR-0066 | Let the persistent PTY manager own bounded terminal replay | partially superseded by ADR-0068 | 2026-07-22 |
| ADR-0067 | Crop terminal viewports below a readable scale | partially superseded by ADR-0068 | 2026-07-22 |
| ADR-0068 | Let the last active terminal viewer own the source grid size | accepted | 2026-07-22 |
| ADR-0069 | Share one web terminal workspace across macOS and iOS | accepted | 2026-07-22 |
| ADR-0070 | Capture paired-client screenshots on demand | accepted | 2026-07-22 |
| ADR-0071 | Reconcile workspace assignments after Mission Control | accepted | 2026-07-23 |
| ADR-0072 | Centralize PTY descriptor custody with live handover | partially superseded by ADR-0080 | 2026-07-23 |
| ADR-0073 | Freshness-first owned media drops obsolete frames instead of waiting for ACKs | accepted | 2026-07-23 |
| ADR-0074 | Own the agent feed source inside AgentDesk | superseded by ADR-0075 | 2026-07-24 |
| ADR-0075 | Load the agent feed by visible layer | accepted | 2026-07-24 |
| ADR-0076 | Let the Mac host own shared voice recordings and analysis | accepted | 2026-07-27 |
| ADR-0077 | Build the workspace IDE surface on Vite, TypeScript and Tailwind, and defer React | accepted | 2026-07-27 |
| ADR-0078 | A PTY session lives as long as its process, and only an explicit act ends it | accepted | 2026-07-27 |
| ADR-0079 | Let the shared web voice session own macOS dictation audio | accepted | 2026-07-27 |
| ADR-0080 | A code update never ends a PTY session | accepted | 2026-07-27 |
| ADR-0081 | Let the containing app own keyboard dictation capture | accepted | 2026-07-28 |
| ADR-0082 | Prewarm host Whisper when the voice sidecar starts | accepted | 2026-07-29 |
| ADR-0083 | Prewarm host Kokoro when the voice sidecar starts | partially superseded by ADR-0084 | 2026-07-29 |
| ADR-0084 | Separate reference cache access from Kokoro model serialization | accepted | 2026-07-29 |
| ADR-0085 | Make practice passages the shared Voice library authority | accepted | 2026-07-30 |
| ADR-0086 | Give the agent feed two views, with the raw one as the fidelity guarantee | accepted | 2026-07-30 |
| ADR-0091 | Own live agent sessions behind provider-neutral backends | accepted | 2026-08-01 |
| ADR-0092 | Restore every standalone tool window through one Desktop placement authority | accepted | 2026-08-02 |
| ADR-0093 | Let the DOM declare the window drag region | accepted | 2026-08-04 |
| ADR-0094 | Stream and drive one window instead of the whole Desktop | accepted | 2026-08-07 |
| ADR-0095 | Relay the agent feed instead of restating it in Swift | accepted | 2026-08-11 |
| ADR-0096 | Serve the dev panel over the tailnet's TLS name, so the phone gets HMR too | accepted | 2026-08-11 |
| ADR-0097 | List a project's sessions from the catalog index, never from transcript bodies | accepted | 2026-08-13 |
| ADR-0098 | Rate-match the media path to the link | accepted | 2026-08-13 |
