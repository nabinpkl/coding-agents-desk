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
| ADR-0028 | Selective packet resend (NACK) and bounded keyframe recovery | proposed | 2026-06-26 |
| ADR-0029 | Capacity survival rung: trade frame rate and bitrate for a slow link | proposed | 2026-06-26 |
| ADR-0030 | Single QUIC session transport for v0 | accepted | 2026-06-27 |
| ADR-0031 | Selected display projection on the client | accepted | 2026-06-27 |
| ADR-0032 | Durable client diagnostics | accepted | 2026-06-27 |
| ADR-0033 | Adaptive media quality ladder | proposed | 2026-06-28 |
| ADR-0034 | Motion-region crisp-repair: revive tiles at rest as a per-region sharpen over video | proposed | 2026-06-28 |
| ADR-0035 | Phone-side agent-feed observability surface fed by an embedded engine sidecar | accepted | 2026-06-30 |
| ADR-0036 | Crisp observe is damage-gated with a periodic full-surface heal | accepted | 2026-07-01 |
| ADR-0037 | Host identity is the bundle id; dev and stable hosts are concurrent variants | accepted | 2026-07-01 |
| ADR-0038 | Mirror Chrome DOM over a dedicated reliable QUIC lane instead of pixels | superseded by ADR-0042 | 2026-07-01 |
| ADR-0039 | Bridge Chrome to the host through a sacrificial native-messaging shim | proposed | 2026-07-01 |
| ADR-0040 | Route phone taps back to Chrome as trusted input via chrome.debugger | proposed | 2026-07-01 |
| ADR-0041 | DOM-mirror hardening: attribute masking, pixel fallback, asset reachability, mask audit | proposed | 2026-07-01 |
| ADR-0042 | Run the DOM recorder in the extension's isolated world, triggered from the chrome layer | proposed | 2026-07-01 |
| ADR-0043 | Compress DOM-mirror batches end-to-end, snapshot as a rare keyframe, chunk as a backstop | proposed | 2026-07-01 |
| ADR-0044 | Tiered DOM-mirror fidelity: isolated adopted-stylesheet enrichment + opt-in CDP keyframe (no MAIN world) | proposed | 2026-07-01 |
| ADR-0050 | Shared wire types as a local Swift package, and modern synchronized Xcode project format | accepted | 2026-07-03 |
| ADR-0051 | Remote SwiftTerm terminal over the Agent Workspace IDE PTY multiplexer | superseded by ADR-0053 | 2026-07-06 |
| ADR-0052 | AgentDesk owns the agent workspace | accepted | 2026-07-10 |
| ADR-0053 | AgentDesk owns the terminal PTY packages | accepted | 2026-07-10 |
