---
name: group-effect
description: Use when writing or reviewing any Group code (the group chat tab's server process and its tests), which is built on Effect v4. Carries where Effect's real API is looked up, how a service module is shaped, typed errors, tracing, scopes and the two lifetimes Group keeps apart (a request's and a room's), child processes, and tests. Group's code follows these from its first file; code elsewhere in this repository is never a precedent for departing from them.
---

# Effect in Group

Group is built on Effect v4 as a pilot for the rest of the sidecar, in a package of its own,
`agent-feed/group/`, with its own compiler settings, lint and tests (ADR-0155; `docs/plans/group-chat.md`,
"How the kernel is built"). This skill is the standard its code is held to. Where these rules and
code elsewhere in this repository disagree, these rules win: the sidecar and the panel grew before
Group and are read for what they learned (`docs/agents/group.md`), never as a pattern to copy. A
rule here that turns out wrong for Group is changed here, with the reason and the date, before code
departs from it.

## The API is looked up, never remembered

Models mostly know Effect v2 and v3, and v4 renamed and moved modules. Before writing or reviewing
Effect code, check the API against the source:

- `.reference/effect`, a full clone of `Effect-TS/effect` (MIT, Effectful Technologies Inc), at the
  version Group pins. `packages/effect/src` is the library: `Schema.ts`, `http/HttpRouter.ts`,
  `http-api/HttpApi.ts`, `rpc/Rpc.ts`, `process/ChildProcess.ts`, `testing/TestClock.ts`;
  `packages/platform/bun/src` is the Bun platform (`BunHttpServer.ts`, the child process spawner).
- `.reference/effect/LLMS.md` and `.reference/effect/ai-docs/src`, the Effect team's own guide for
  agents: `01_effect` (services, errors, resources, running), `03_stream`, `08_observability`,
  `09_testing`, `51_http-server`, `60_child-process`.
- An answer is backed by a file in that tree, or by the Group code already written to this skill.
  Group's own `node_modules/effect/src` holds the source of the exact version it runs.

Bring the clone up to date with `git -C .reference/effect pull`, and check out the tag Group pins
(`git -C .reference/effect checkout effect@<version>`) when the latest has moved past it.

## A service module

Group's features are services; transports (HTTP routes, streams) stay thin. Adapted from t3code's
`docs/internals/effect-services.md` (`.reference/t3code`, MIT, T3 Tools Inc) and OpenCode's Effect
skill (`.reference/opencode/.opencode/skills/effect`, MIT, opencode).

- **One module per service**, in this order: imports, errors and schemas, the `Context.Service` tag
  with its interface inline, `make`, then `layer`. The interface is named `Foo["Service"]`, never a
  standalone `FooShape`.
- **Imports are namespaces from subpaths:** `import * as Effect from "effect/Effect"`, never
  `import { Effect } from "effect"`. A service module is imported the same way and used as
  `yield* Foo.Foo` and `Foo.layer`. The subpath is for cost: every static import loads its file
  before the program starts, and the `effect` root re-exports all 143 modules, which Bun loads in
  full (on Bun 1.3.13 and Effect 4.0.6, 2026-10-25: 71 ms for a script importing the root, 23 ms
  for `effect/Effect`, 21 ms for a named import from it). The namespace is for names: `map`,
  `filter` and `make` are in `Effect`, `Stream`, `Option` and `Layer` alike, and a namespace never
  needs one renamed. OpenCode bans `import * as`; Group follows t3code here.
- **Dependencies come from the environment** (`yield* FileSystem.FileSystem`), never as parameters to
  `make`, never hidden in a module global, a closure over a singleton, or a `Layer.succeed` that
  calls imperative APIs. Configuration and plain values may be parameters.
- **Bind a service to a name before calling it.** No `yield* (yield* Foo.Foo).bar()`.
- **A handler decodes, calls one service method, and maps errors.** Nothing else: process, file,
  hub and persistence work, retries and rollback belong in the service, so the same capability is
  reachable from a route, a test and a later tool without a socket.
- **Moving a service deletes the old file and updates every consumer.** No re-export shims.

## Seeing what a file depends on

An import line names modules, not the functions used from them, and Group does not try to make it
list more. Each question has its own place to look:

| Question | Where it is answered |
| --- | --- |
| which modules a file uses | its imports |
| which services it needs | the requirements of its `make` and `layer`: `Layer<Room, never, Hub \| FileSystem>`, checked by the compiler |
| which code may import which | `agent-feed/group/.oxlintrc.json`, on every gate |
| where a function is called | a search for `Module.fn(`, which a namespace makes exact |

The second row holds only while every dependency comes from the environment, so files and
processes are reached through Effect's services (`yield* FileSystem.FileSystem`,
`yield* ChildProcessSpawner.ChildProcessSpawner`), not `node:fs`, `node:child_process` or
`Bun.spawn`, which a type never shows and a test layer cannot replace. Those stay in a `*Main.ts`
entry point and in tests. That is stricter than t3code, whose server mostly yields the services
but still imports `node:fs` in some 19 source files (2026-10-25); Group has no old code to carry,
so it can hold the line from its first file. A Node built-in that is used is imported as one
namespace named for it, after t3code's `namespace-node-imports` rule: `import * as NodeFS from
"node:fs"`, `NodePath` for `node:path`, `NodeFSP` for `node:fs/promises`, `NodeChildProcess` for
`node:child_process`, so a call says it is Node's.

## Functions and tracing

- A reusable effectful function is `Effect.fn("Service.operation")`, which creates a span with a
  stable name. `Effect.gen` stays for inline programs and layer construction. `Effect.fnUntraced`
  only where a span per call would be noise (a stream chunk, an event), with the reason beside it.
- A handler adds its per-call context with `Effect.annotateCurrentSpan`, not a span of its own.
- Spans reach the sidecar's archive through Group's own `Tracer` onto Sentry's span API (U7 in the
  design doc). `@effect/opentelemetry`'s global layer reaches nothing under Sentry 11 on Bun; do
  not use it.
- A helper returns an `Effect` only when it does effectful work. Parsing, validation and option
  building stay synchronous.

## Errors

From t3code's rules, which Group adopts whole:

- Failures are `Schema.TaggedError` classes with structured attributes (the operation, the
  resource id, a category). The message is fixed or built from those attributes, never from
  `cause` or its text. (OpenCode's skill names `Schema.TaggedErrorClass`, which Effect 4.0.6 does
  not have: the case for looking APIs up.)
- An error that wraps a failure keeps it as `cause`.
- **Attributes stay safe:** no raw payloads, command lines, prompts, output, credentials or account
  identity. The spikes found an MCP server's API key on a command line and the account's email on
  every Claude telemetry event; the exact value lives only in `cause`, and only when it must.
- An error is made where the failure happens and mapped to a transport error only in the
  transport. Known tags are caught with `Effect.catchTags({ ... })`.
- Untrusted input is decoded once, with `Schema`, at the boundary that owns it (an HTTP body, a
  file on disk, a hub message); typed values travel inward and are not checked again.

## Two lifetimes: a request's and the room's

- **A reader watches; it never owns work** (principle 5). A stream to the panel runs in its
  request's scope and ends when the reader leaves, which on Bun 1.3.13 interrupts the request
  within a millisecond (U8). A wave, a turn and a lane are forked into the room's scope
  (`Effect.forkIn(work, room)`), never into a request's.
- **A lane belongs to its lease, not to the process that started it** (invariant 4). Release a
  spawned lane from its scope with `handle.unref` once it has started, and record its lease (pid
  and start time) before admitting anything else. A graceful exit of Group runs every scope's
  cleanup, so a lane left in a scope dies with each restart (U9). Only an explicit stop, an expired
  lease or a tripped breaker kills it.
- `runPromise`, `runFork` and `ManagedRuntime` appear only at the program's edge (its `main`, a
  test). Never inside a service.

## Child processes

- Spawn through `ChildProcessSpawner` with `forceKillAfter` always set: without it, a stop waits
  forever on a process that ignores SIGTERM (U6).
- Effect's spawner reaches its own process group only. Claude's Bash tool runs each command in a
  group of its own, and a grandchild can start a session of its own, so Group's census of a lane's
  descendants and its start-time check are Group's own code, on top of the spawner (U5, U6).
- SIGTERM comes first, then the grace, then SIGKILL to every group the census found: on SIGTERM,
  Claude cleans up its own tree and flushes its spans (U1, U5).
- A lane writes to files (its transcript, its output), never to a pipe into Group, so the process
  reading them can change under it.
- The process module is marked unstable. Its version is pinned, and every upgrade runs the
  restart and kill tests in the failure table first.

## Tests

- Tests run on `bun test`, the runtime Group runs on, through `@/testing/effectTest`, adapted from
  OpenCode's helper (ADR-0155): `it.effect` runs on a `TestClock`, so time moves only with
  `TestClock.adjust`; `it.live` only for real processes, sockets and files; `testEffect(layer)`
  gives both with stand-ins provided. A test that reaches past loopback fails. A test never waits
  for a length of time. Not `@effect/vitest`: it needs vitest's runner and fails under `bun test`.
- A handler is tested in memory through `HttpApiTest.groups(api, [...])`, and the served routes on
  a real Bun server through `BunHttpServer.layerTest`, which listens on an ephemeral port and
  provides an `HttpClient` pointed at it.
- Test layers stand in for what is outside Group (the hub, a harness); the logic under test is
  never mocked.
- Each row of the design doc's failure table is a test, written before the code that passes it.

## What the gate enforces

Part of this skill is checked on every `just check`, so a review need not catch it:

- **The compiler** (`agent-feed/group/tsconfig.json`, the `agent-feed-group-check` leg): t3code's
  strict settings, `exactOptionalPropertyTypes` among them.
- **oxlint** (`agent-feed/group/.oxlintrc.json`, run on its own by check 8 of
  `tools/agent-feed-fitness.sh`): Group imports nothing from the rest of the repository, no named
  imports from the `effect` root, no timers (`setTimeout`, `setInterval`, `Bun.sleep`,
  `node:timers`) anywhere, no chokidar, and the type-aware rules the sidecar runs. The
  repository's `.oxlintrc.json` keeps Effect and Group out of the sidecar.
- **ast-grep** (`agent-feed/group/ast-grep/`): no `Effect.run*` or `ManagedRuntime.make` outside a
  `*Main.ts` entry point, a test or the test helper, no `node:fs`, `node:child_process` or `Bun.spawn` and its kin
  outside them either, Node built-ins only as `Node`-named namespaces, no nested service yields,
  no aliased value imports, no `JSON.parse(...) as`, no `Effect.die` with a string, and OpenCode's
  five Effect simplifications.
  The rules' own tests run every time, so each is shown failing before it is trusted.

The rest (spans named with `Effect.fn`, safe error attributes, a request's scope versus the room's)
is still the reviewer's to check against this skill.

## Before you hand off

- Does any handler do more than decode, call and map errors?
- Is every reusable function an `Effect.fn` with a stable span name?
- Does any error attribute or span carry a payload, a command line or an identity?
- Is any work forked into a request's scope, or any lane left in a scope?
- Was each Effect API you used checked against `.reference/effect`?
- Did anything depart from this skill because code elsewhere in the repository does it that way?
  That is not a reason; change the skill first, or change the code.
