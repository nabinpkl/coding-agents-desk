# agent-feed wire types

The **one** definition of everything that crosses the agent-feed HTTP boundary. The sidecar
constructs these shapes; the Agent Panel consumes them. Nothing else states them.

Before this module the same model was written out four times — here in TS, again in the host's
`AgentFeedSidecarClient` (long keys), again in `AgentDeskWire/AgentFeed.swift` (abbreviated keys),
with `AgentFeedBridge` renaming one into the other. Per-side tests passed on both sides of every
drift. Swift now relays bytes and names no field, so this is the only place left to change.

## Rules

1. **Types only.** No `const`, no `function`, no `class`, no `enum` — nothing that survives type
   erasure. Both consumers import with `import type`, so this module is erased at build time and
   neither project has to bundle or resolve it at runtime.
2. **Long keys.** The sidecar's own shape travels unchanged. Abbreviation used to exist to shrink
   the QUIC lane; it cost a rename layer in Swift and bought nothing else. If wire size measures
   badly, compress at the relay.
3. **No import from either consumer.** This module is a leaf. It may not reach into
   `agent-feed/sidecar` or `packages/AgentPanel/Web`.

## How it is resolved

Neither project has a workspace (`ensure-js-dependencies.mjs` requires exactly one lockfile per
project and installs `--frozen-lockfile`), so this is wired by `tsconfig` path mapping rather than
by a dependency:

- `agent-feed/sidecar/tsconfig.json`
- `packages/AgentPanel/Web/tsconfig.json`

Both map `@agentdesk/agent-feed-wire` here. Because every import is `import type`, no bundler
config is needed on either side.

## Adoption status

The sidecar declares nothing of its own any more: `transcriptTypes.ts`, `agentBackend.ts`,
`liveAgentProjection.ts`, and `transcriptCatalog.ts` re-export these types so their importers did
not have to move.

The panel still keeps its own `ActivityEvent` / `ActivityBlock` / `TokenUsage` in
`useSessionEventsStream.ts`. That is not a second wire definition — it is a *normalization target*,
deliberately looser (optional `id` and `revision`, an extra `"error"` phase) because
`activityNormalization.ts` rebuilds every event field by field from whatever arrives. Collapsing it
onto these types means deciding what identity a malformed event gets, which belongs with the
data-source rewrite that deletes `BridgeDataSource`, not before it.
