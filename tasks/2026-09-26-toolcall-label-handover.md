# Handover: agent-feed toolcall labels (working title: Toolcall labels handover)

Date: 2026-09-26. Parent session: Tool Call Editor (tmp cwd, ses_f2816c752ffeTech7Bfc1ATfXv).

## Standing order: DO NOT EDIT anything yet

Read-only until the owner says go. Reading files, running tests, and
inspecting git state are fine. No edits, no writes, no commits, no
state-changing commands. When you have read this file and verified the
tree state below, announce yourself (see bottom) and stop.

## Objective

Short intelligent titles ("this is doing what") for the agent-desk
activity feed, starting with opencode shell calls that lacked
descriptions. All later extensions in this arc:

1. Shell labels: pipe stages named per stage, tail/head line counts
   dropped, middle grep demoted to "filter for".
2. Edit detail row under Edit headers: function adds/removes, imports,
   calls, scope-attributed fragments, comment-only edits, argument-only
   call updates.
3. Feed links open in a new tab (Markdown sanitizer forces
   target=_blank + rel=noopener).
4. Newest-shell auto-expand removed: every shell row opens on click.

## Constraints (still hold)

- No model sees credentials; secret-shaped commands never reach any
  model; sanitizer runs first regardless.
- Deterministic heuristics only, zero new dependencies.
- Claude rows keep harness descriptions; only undescribed opencode
  calls get labels.
- Tree is shared with other active workers: touch only the files
  listed as ours below.

## Our files (uncommitted)

Modified:
- agent-feed/sidecar/src/agents/opencode/opencodeEventMapper.ts
- agent-feed/sidecar/src/agents/opencode/opencodeEventMapper.test.ts
- packages/AgentPanel/Web/src/features/activity-feed/activityFeedScrollMemory.test.tsx
- packages/AgentPanel/Web/src/features/activity-feed/blocks/ActivityBlockViews.test.tsx
- packages/AgentPanel/Web/src/features/activity-feed/blocks/ActivityBlockViews.tsx
- packages/AgentPanel/Web/src/features/activity-feed/markdown/Markdown.test.tsx
- packages/AgentPanel/Web/src/features/activity-feed/markdown/proseBlocks.ts
- packages/AgentPanel/Web/src/features/activity-feed/rows/useFeedRows.ts
- packages/AgentPanel/Web/src/features/activity-feed/blocks/ActivityEventRows.test.tsx (one blank line only)

New (ours):
- agent-feed/sidecar/src/summary/shellLabels.ts (+ .test.ts)
- packages/AgentPanel/Web/src/features/activity-feed/blocks/describeEditChange.ts (+ .test.ts)

NOT ours (another worker's, leave alone):
- agent-feed/hub/deploy/rotate-service-tokens.mjs

Known pre-existing noise: tsc errors in
`useSessionEventsStream.ts` are another worker's, not from this arc.

## Key behavior contracts

- `shellLabels.ts`: every significant pipe stage names itself; tail/head
  add nothing; quoted grep patterns extract whole; secrets redact.
- `describeEditChange(old, new, filePath?)`: tiers in order are
  signatures, imports, comments, calls (added/dropped/updated-args),
  scope, bare counts. `filePath` keeps markdown `#`/` *` prose out of
  the comment tier. Comment tier: `comment: before → after`, or
  `comment in f(): ...` with scope. Args tier:
  `updates f(): +newArg` / `a → b` / `-gone`.
- `proseBlocks.ts` sanitizer forces `target="_blank"`
  `rel="noopener noreferrer"` on every anchor with href.
- `useFeedRows.ts`: no auto-expand; `activityFeedScrollMemory.test.tsx`
  pins "keeps every shell call collapsed until opened on click".

## Verify (read-only)

- Sidecar: `bun test src/summary/ src/agents/opencode/` then `bunx tsc --noEmit`
- Panel: `npx vitest run src/features/activity-feed/blocks/` then
  `npx tsc --noEmit` (ignore useSessionEventsStream errors)
- Expected: sidecar 116+ pass, blocks 103 pass, both typechecks clean.

## Next moves (do NOT start; owner decides)

1. Extend verb/function patterns from the next real feed miss.
2. Cap the arg excerpt tighter if long calls crowd narrow rows.
3. Remove `/Users/dev/projects/tmp/toolcall-label/` scratch,
   keeping `eval-ad.json` as the regression set.

## Announce step (do this, then stop)

Using the `agentdesk-relay` MCP server, `hub_send` a `kind: "notice"`
to `AD bot` saying you are the handover session for the toolcall-label
arc, that you have read this file, verified the tree, made zero edits,
and are waiting for the owner's go-ahead. Then end your turn.
