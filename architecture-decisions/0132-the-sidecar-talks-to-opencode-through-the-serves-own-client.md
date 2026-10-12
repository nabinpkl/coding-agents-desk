---
status: accepted
date: 2026-10-12
supersedes:
  - ADR-0116
  - ADR-0131
---

# The sidecar talks to opencode through the serve's own client, pinned to the serve's release

Supersedes one clause of ADR-0116 (the client is `@opencode-ai/sdk`) and one of ADR-0131 (the
rules ride the create as `$body_permissions`). Everything else in both stands.

## Context and Problem Statement

The sidecar pinned `@opencode-ai/sdk` 1.18.31 while this machine's serve runs opencode 2.0.16.
The 1.x line ends at 1.19.0, which is no closer: opencode 2.x publishes its client as a
different package, `@opencode/client`. The gap was not cosmetic. Measured against the live
serve on 2026-10-12:

- The serve emits `permission.asked` and `form.created`. The sidecar switched on the old SDK's
  `permission.v2.asked` and `question.v2.asked`, so no opencode permission or question ever
  reached the panel's broker; each sat on the serve unanswered.
- A shell message carries `shellID` and an `output` object, not `callID` and a string, so a
  shell row had no call id and was handed an object where it expected text.
- `session.error`, `session.updated`, `session.compacted` and `session.next.compaction.*` no
  longer exist; their cases were dead.
- The SDK's request builder dropped a create's `permissions` without an error, which is what
  ADR-0131's `$body_` escape was routing around.

Every probe aimed at the panel found a healthy layer, because the old types compiled against
code reading fields the serve had stopped sending.

## Decision Outcome

- **`@opencode/client`, pinned exactly to the serve's version (2.0.16).** It resolves each
  call to its body and throws a `ClientError` (status on `cause`) on failure, where the old SDK
  resolved `{ error }`. `@opencode-ai/sdk` is removed.
- **The router dispatches on the serve's own event names**: `session.execution.failed` marks
  a session errored, `session.renamed` and `session.moved` refresh the catalog,
  `permission.asked` replies through `client.permission.reply`, and `form.created` asks each
  field through the broker -- a choice as a select, a yes or no as a confirm, anything typed as
  an input, an external link skipped -- and replies with the answers by key.
- **Arena rules ride the create as the typed `permissions` field**, and the backend checks
  the session the serve returns holds exactly them, removing it and failing otherwise. Closed
  fail-open by construction rather than by a spelling the next client could drop.
- The raw calls beside the client (prompt, message paging, command) stay raw: each parses
  only the fields it reads, and the client has no paged message list.

## Consequences

- **The client must move with the serve.** A serve upgrade that renames events again shows up
  as a typecheck failure only once this pin moves too; until then it looks like a quiet panel.
  Bump `@opencode/client` to the serve's version whenever the serve is upgraded.
- Opencode permissions and questions now reach the panel for every opencode session, not only
  arena ones. That is a behaviour change for the reader: prompts that used to sit unanswered on
  the serve now appear in the session's UI.
- Verified live: 50 sessions listed, 15 paged with shell rows drawn whole, a permission asked
  and answered through the broker, and an arena contestant's full turn closing in 5.9s.
