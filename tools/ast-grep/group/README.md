# Group's ast-grep rules

Structural lint for Group's Effect code (`agent-feed/sidecar/src/group/`), the half of its
standards (`.agents/skills/group-effect/SKILL.md`) that oxlint's import rules cannot see. Check 8 of
`tools/agent-feed-fitness.sh` runs `ast-grep test` on every gate, so every rule is shown failing on
its own invalid cases, and `ast-grep scan` over Group's code once that code exists.

```sh
packages/AgentPanel/Web/node_modules/.bin/ast-grep test -c tools/ast-grep/group/sgconfig.yml
packages/AgentPanel/Web/node_modules/.bin/ast-grep scan -c tools/ast-grep/group/sgconfig.yml agent-feed/sidecar/src/group
```

## Where the rules come from

Nine rules, with their tests and snapshots, are copied unchanged from OpenCode
(`https://github.com/anomalyco/opencode`, `script/ast-grep/` at `32b57015e5`, 2026-10-25), under its
MIT licence, reproduced in `LICENSE-opencode` here (Copyright (c) 2025 opencode):

- from `script/ast-grep/rules/`: `no-effect-die-string`, `no-json-parse-cast`,
  `no-nested-effect-service-yield`, `no-import-alias`;
- from `script/ast-grep/effect-simplifications/rules/`, the TypeScript variants:
  `no-effect-and-then-succeed-undefined`, `no-effect-catch-fail`, `no-effect-catch-succeed`,
  `no-effect-flat-map-suspend`, `no-identity-pipe`.

Not copied: OpenCode's `no-star-import`, which bans `import * as`, because Group imports Effect
modules as namespaces from their subpaths (`import * as Effect from "effect/Effect"`), after t3code's
rules; and `no-drizzle-column-name`, which is about a database layer Group does not have.

Group's own: `no-run-outside-edge`, which keeps `Effect.run*` and `ManagedRuntime.make` to a
program's `*Main.ts` entry point and its tests.

Bring a copied rule up to date by copying it again from `.reference/opencode` and noting the commit
above.
