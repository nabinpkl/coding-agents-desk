---
status: accepted
date: 2026-09-30
---

# The IDE's file and text search run on ripgrep, over one scope

## Context and Problem Statement

The workspace IDE (`packages/AgentPanel/Web/src/features/workspace-ide/`) had no search. Two were
asked for together: quick open (double Shift, Cmd+P) to find a file by a fuzzy fragment of its
name, and text search (Cmd+Shift+F) to find lines. The tree cannot answer either -- it is lazy, and
the sidecar lists only directories a reader has expanded -- so the sidecar needs a way to list
every file and to search inside them, on every machine a workspace can live on.

## Decision Drivers

- A workspace can be one repository or a parent folder of many (`~/projects`), and the answer must
  respect each project's own `.gitignore` in both cases.
- Measured 2026-09-30 on `~/projects`: 220,898 files with nothing ignored, 24,852 with ignore files
  honoured, 7,247 of those in one unignored `node_modules`. Ignore files alone are not enough.
- The caller is unauthenticated (AGENTS.md: the tailnet is the boundary), so whatever runs takes a
  query from anyone on it.
- Fuzzy matching has to score every candidate on every keystroke. Over file names that is 17,605
  strings for the largest folder here; over content it is 2.6 million lines and 306MB.

## Considered Options

- **ripgrep for both**, file names matched fuzzily in the panel, content matched exactly by `rg`.
- **`git ls-files` for names and `git grep` for content.**
- **A walk in the sidecar**, with our own ignore handling and a JavaScript search.

## Decision Outcome

Chose **ripgrep for both**. `git` answers nothing in a folder that is not a repository, which is the
parent-folder case; a walk of our own would re-implement gitignore semantics and parallel
traversal that `rg` already has, and measured 30 to 100ms for a full listing. Fuzzy matching lives
in the panel over the list, because the list is small and a round trip per character is not;
content is exact (smart case, several words in any order, optional regex, include and exclude
globs), because fuzzy over content would mean shipping or scoring the whole corpus.

One scope serves both searches (`workspace/search/searchScope.ts`): `--no-config`, `--hidden`,
`--no-require-git` with `--no-ignore-parent`, and a fixed exclude list (`.git`, `node_modules`,
`bower_components`, and VS Code's other defaults). `--no-ignore-parent` is not optional once
`--no-require-git` is on: without a repository to stop at, `rg` reads ignore files all the way up,
and this Mac's `~/.gitignore` is `*`, which hid every file of every workspace.

A search answers whole rather than streamed. Streaming would ride `EventSource`, which reconnects
when a stream ends and so runs the same search again; one query over the largest folder answers in
about half a second, and a query typed past is cancelled by aborting its request, which kills `rg`
through the request's own signal.

A text search result opens in a **preview tab**: a `previewPath` slot in the shared workspace state
that the next preview replaces in place, kept by an `open` or an edit. Without it, stepping through
twenty results left twenty tabs on every reader's screen.

### Consequences

- Good, because one tool and one scope mean the two searches cannot disagree about what exists.
- Good, because a query is only ever an argv element after `--`, and `--no-config` keeps an
  environment's `RIPGREP_CONFIG_PATH` from adding flags such as `--pre`.
- Bad, because `rg` is now a program every machine running a sidecar needs. `config.ripgrepPath`
  finds it by absolute path, as `tmux` is found, and a machine without it gets a 503 naming it
  rather than an empty result.
- Bad, because a workspace rooted below its repository's top no longer sees the top's `.gitignore`.
- Neutral, because the exclude list is fixed. Per-workspace excludes would belong on the sidecar's
  workspace record, and nothing has asked for them yet.

### Confirmation

`agent-feed/sidecar/src/workspace/search/*.test.ts` and `workspaceSearchRoutes.test.ts` pin the
scope, the refusals and the argv hazards against a real `rg`; `chrome-test/ide-search-verify.mjs`
(`just ide-search-verify`) drives both searches on the live panel.

## Links

- ADR-0077 the workspace IDE's web stack
- VS Code's `search.exclude`, `files.exclude`, `search.maxResults` defaults
