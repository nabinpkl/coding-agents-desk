# Group: how to work in `agent-feed/group`

Group is the group chat tab's server process, built on Effect as the pilot for the rest of the
sidecar, in a package of its own (ADR-0155). The repository root `AGENTS.md` still applies here.
Before changing anything in this package, read `docs/agents/group.md`, then the `group-effect` and
`group-api-design` skills. The rest of the repository is behaviour to port, never a precedent for
departing from them.

## What is here

- `src/GroupMain.ts`: the entry point, the one place the program is run.
- `src/api/`: the HTTP contract (`GroupApi.ts`), from which the server, the OpenAPI document at
  `/api/group/openapi.json` and any typed client are built.
- `src/http/`: handlers and the routes served on whatever HTTP server is provided.
- `src/config/`: every setting Group reads. `AGENTDESK_GROUP_PORT` is required;
  `AGENTDESK_GROUP_HOST` defaults to `127.0.0.1`.
- `src/testing/effectTest.ts`: `it.effect`, `it.live` and `testEffect`, after OpenCode's helper.
- `tsconfig.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `ast-grep/`: this package's own compiler
  settings, Effect checks, lint and formatting.
  The repository's `.oxlintrc.json` never reaches these files, so a rule for Group goes here.

## Commands

From this directory:

- `bun run typecheck`, `bun run effect-check`, `bun run lint`, `bun run format:check` and
  `bun run test`, which `just agent-feed-group-check` runs in that order as the gate's leg for any
  change under `agent-feed/group/`. `bun run format` rewrites Group's files.
- `AGENTDESK_GROUP_PORT=<port> bun run start` serves Group by hand. The supervisor does not start
  it yet, and the panel does not route `/api/group/` to it yet.

Every tool those run is this package's own dev dependency (TypeScript, `@effect/tsgo`, oxlint and
its type checker, oxfmt, ast-grep), at its latest release: `bunfig.toml` turns off the global
48-hour release-age wait for this package. Nothing here depends on the panel's or the sidecar's
`node_modules`. What the repository asks of every tree still applies, from the fitness leg: the
file and directory caps, imports by absolute path, and the public scan.

The source of the Effect version Group runs is in `node_modules/effect/src`, and the full history
in `.reference/effect`: look an API up there before using it.
