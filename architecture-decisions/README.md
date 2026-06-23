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
