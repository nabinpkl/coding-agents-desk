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
- `tsconfig.json`, `.oxlintrc.json`, `ast-grep/`: this package's own compiler settings and lint.
  The repository's `.oxlintrc.json` never reaches these files, so a rule for Group goes here.

## Commands

From this directory:

- `bun run typecheck` and `bun run test`, which `just agent-feed-group-check` runs as the gate's
  leg for any change under `agent-feed/group/`.
- `AGENTDESK_GROUP_PORT=<port> bun run start` serves Group by hand. The supervisor does not start
  it yet, and the panel does not route `/api/group/` to it yet.

Lint runs from the repository root, in the fitness leg of `just check`:

```sh
OXLINT_TSGOLINT_PATH="$PWD/packages/AgentPanel/Web/node_modules/.bin/tsgolint" \
  packages/AgentPanel/Web/node_modules/.bin/oxlint -c agent-feed/group/.oxlintrc.json agent-feed/group/src
packages/AgentPanel/Web/node_modules/.bin/ast-grep scan -c agent-feed/group/ast-grep/sgconfig.yml agent-feed/group/src
```

The source of the Effect version Group runs is in `node_modules/effect/src`, and the full history
in `.reference/effect`: look an API up there before using it.
