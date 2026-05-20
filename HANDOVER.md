# Handover

Snapshot of what landed during the initialization pass and what plausibly comes next. Read after `AGENTS.md` (and the absolute-path files it tells you to load). Update or replace this file as the project moves.

## What landed

Repo initialized as a scaffold. No code, no decisions yet. Files present:

- `CLAUDE.md`: single line, `@AGENTS.md`.
- `AGENTS.md`: opens with a load directive listing the two absolute paths to the shared rule files. Below the directive sits the project-context section, all five fields populated with `TBD` placeholders so the structure is visible and the gaps are explicit.
- `README.md`: human-facing summary mirroring the same `TBD` framing so the two docs cannot disagree at fill-in time.
- `.gitignore`: blocks `.env`, `.env.local`, macOS atomic-write temp files, and `.DS_Store`. The env entries reflect the no-hardcoded-configs rule.
- `architecture-decisions/`:
  - `README.md`: generic ADR lifecycle and conventions. Empty index table.
  - `TEMPLATE.md`: MADR 4.0 shape with the team-RACI metadata trimmed.

Cross-cutting worker rules and the TASKS.md shape do NOT live in this repo. The load directive at the top of `AGENTS.md` lists their absolute paths.

## What was deliberately not done

- No language or stack chosen. No package manager files, no lockfiles, no build config.
- No `TASKS.md`. The guidelines file says one ledger per iteration; no iteration has opened yet.
- No ADRs. The folder exists with template and conventions; the index is empty.
- No `Justfile`. The universal rules suggest one for common workflows; nothing to wrap until the stack exists.
- No source directories of any kind.
- No project-context content. The five required headings in `AGENTS.md` (`What this is`, `What this is not`, `Current iteration`, `v0 / current scope`, `Explicitly deferred`) are placeholders.

## Where the human's input is needed

The repo will not become useful until the human has answered, at minimum:

- What is this project for? One paragraph naming the load-bearing primitive it builds on.
- What is it explicitly NOT for? Non-goals.
- What is the v0 slice that proves the thesis?
- What language and runtime?

These are scope decisions, not implementation decisions. Surface them as questions; do not invent answers.

## Next directions

1. Ask the human for the four items in the section above and write the answers into `AGENTS.md` and `README.md`. Do not start any other work first; the project-context section is the load-bearing fight-scope-creep surface, per the shared rules.
2. Once the stack is chosen, add the matching language profile load-instruction to `AGENTS.md` next to the existing ones, and write the language/runtime/package-manager choice into the `Stack` section. If the choice deserves an ADR (non-default runtime, unusual framework), open `architecture-decisions/0001-<language-and-runtime>.md` from `TEMPLATE.md` in the same change.
3. When the first iteration opens, create `TASKS.md` at the repo root following the guidelines file the load directive points at. Open with the `Position` section; the iteration's first task is usually a readiness-review ADR.
