# agent-desk

TBD. One paragraph describing what this project is and the load-bearing idea it sits on. Fill in alongside the `What this is` section of `AGENTS.md`.

## Status

Initialized. Scope, stack, and v0 surface are still to be defined. See `AGENTS.md` for the project-context section that will hold those decisions once they exist.

## What this is for

TBD.

## What this is not

TBD.

## v0 scope

TBD.

## Stack

TBD. Once chosen, document here and import the matching language profile in `AGENTS.md`.

## Repository layout

- `CLAUDE.md`: session-load instructions. Names the absolute paths to the shared rule files (which live outside this repo) and points at `AGENTS.md`.
- `AGENTS.md`: project-specific context. Project-only; cross-project rules are loaded via the paths in `CLAUDE.md`.
- `architecture-decisions/`: one ADR per decision. `TEMPLATE.md` is the starting shape; `README.md` documents the index and lifecycle.

## Conventions

- Cross-cutting worker rules and TASKS.md guidelines live outside this repo; `CLAUDE.md` lists where. Agents must load them at session start and after any context compaction.
- ADRs follow `architecture-decisions/TEMPLATE.md`. New ADRs append to the index in `architecture-decisions/README.md`.
