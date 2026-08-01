---
status: accepted
date: 2026-08-01
---

# Own live agent sessions behind provider-neutral backends

## Context and Problem Statement

The Agent Panel already projects Claude and Codex transcripts through a Bun sidecar and the shared
Mac/iPhone bridge, but it cannot own an agent run or replace one timeline item while a response
streams. Pi is installed and authenticated on the host and exposes an official SDK, persistent JSONL,
built-in tools, queue semantics, and extensions. AgentDesk needs those capabilities without exposing
Pi schemas to the webview or coupling future providers to Pi.

## Decision Drivers

- The same authoritative session must synchronize across Mac and iPhone viewers.
- Existing HTTP/SSE, authenticated QUIC, virtual feed, and Pi SDK behavior should be reused.
- Model/tool authority and credentials must not enter a webview or unauthenticated loopback API.
- A future process or PTY-backed provider must fit without adopting Pi's data model.

## Considered Options

- **Spawn the Pi CLI in a PTY** and parse terminal bytes.
- **Expose Pi RPC or session schemas directly** to the React surface.
- **Own Pi's SDK runtime behind an AgentDesk backend and projection**.
- **Copy a community Pi web server and UI** into AgentDesk.

## Decision Outcome

Choose **an AgentDesk backend and projection around the official Pi SDK**. The sidecar owns one
`AgentSessionRuntime` per active Pi session, maps SDK events into stable revisioned AgentDesk activity
items, and fans sequenced envelopes out to viewers. Existing Claude/Codex indexing is wrapped as a
read-only transcript backend. The native host remains the only HTTP client; a random per-spawn bearer
capability authenticates all sidecar reads, streams, and mutations. Protocol v16 carries generic
source identifiers, capabilities, mutable timeline envelopes, and correlated commands.

Pi uses its existing agent directory, authentication, settings, model selection, JSONL
`SessionManager`, built-in bash tool, and extension loader. Normal input prompts while idle and queues
a follow-up while active; steer is explicit and abort ends only the active run. Multiple viewers may
issue commands, serialized per session with request-id idempotency instead of a writer lease.

The first slice supports tool-only extensions and provider-neutral select, confirm, input, editor,
and notification requests. First valid viewer response wins. Terminal-only custom extension UI fails
explicitly. Pi sessions do not expose raw mode or Agent Panel terminals, and this decision adds no
workspace manager or arbitrary-folder picker.

### Consequences

- Good, because Pi streaming, bash, persistence, OAuth reuse, and extensions remain owned by Pi.
- Good, because web, native, and wire code depend only on AgentDesk contracts.
- Good, because one server projection supplies replay, snapshot recovery, and multi-viewer state.
- Bad, because active model work cannot resume across a sidecar crash; the reopened JSONL reports the
  interruption instead of pretending it resumed.
- Neutral, because Claude and Codex remain read-only until another backend deliberately owns them.

### Confirmation

Tests must prove revision replacement, sequence-gap recovery, multi-subscriber fan-out, command
idempotency, authenticated HTTP, Pi event mapping, extension first-response-wins behavior, and v16
wire round trips. An end-to-end smoke must create a Pi session, stream a built-in bash call to two
subscribers, and reopen the persisted JSONL without any Pi type appearing outside the sidecar.
`just agent-feed-pi-smoke` is that checked-in authenticated SDK gate; it also proves the sidecar
control capability is absent from Pi's built-in bash environment.

## Links

- `SPEC.md` Live Agent Session Flow
- ADR-0056 Bottom Agent Panel terminal
- ADR-0075 Load the agent feed by visible layer
- Pi SDK session runtime example, repository inspected 2026-08-01:
  https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/sdk
- Narumi projection reference, commit `a228dfccca136f4f1dbb27944683cfb2b6478544`, inspected
  2026-08-01: https://github.com/narumi-tr/pi-webui
- Agegr lifecycle reference, commit `dfab5853b8d2f717df259e7ebc94f49a3c2e43e7`, inspected
  2026-08-01: https://github.com/agegr/pi-web
