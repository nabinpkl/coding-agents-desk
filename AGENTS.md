# Load these first

**At session start, and again after any context compaction, read these files if they are not already in context. Do not skip. Do not assume they are loaded.**

1. `/Users/dev/projects/atc/taste/library/universal-AGENTS.md` — cross-cutting worker rules. Authoritative for voice, scope discipline, output format, coding rules, and how to write for other agents.
2. similarly `atc/taste/library/iteration/TASKS-MD-Guidelines.md` — the shape of `TASKS.md` for any iteration that opens.

These files do not live in this repo. They are referenced by absolute path from the canonical location. If a path no longer resolves, stop and surface the failure instead of inventing rules.

After loading acknolwedge to the user that you loaded these.

# Project context

> The cross-cutting worker rules and TASKS.md guidelines do not live in this repo. `CLAUDE.md` lists the absolute paths and instructs the agent to load them at session start and after compaction. If you are reading this file directly, confirm those files are loaded before acting.

## What this is

TBD. Fill in: one paragraph describing the product and the load-bearing primitive it builds on.

## What this is not

TBD. Fill in: explicit non-goals so agents do not invent features outside scope.

## Current iteration

TBD. Fill in: the questions this version answers.

## v0 / current scope

TBD. Fill in: the thinnest end-to-end slice that proves the thesis.

## Explicitly deferred

TBD. Fill in: features that look adjacent but are out of scope for this iteration.

## Stack

TBD. Languages, runtime, package manager, frameworks are not yet decided. Once chosen, document the stack here and add a load-instruction in `CLAUDE.md` for the matching language profile (path under the canonical taste-library location).

## Iteration ledger

When the first iteration opens, create `TASKS.md` at the repo root following the guidelines file listed in `CLAUDE.md`. That file is the source of shape and conventions; do not duplicate them here.

## Architecture decisions

`architecture-decisions/` holds one ADR per decision. `TEMPLATE.md` is the starting shape; `README.md` describes the index and lifecycle conventions for this repo.
