# Agent Feed Bots: rough direction

> Status: exploratory direction with an implemented baseline, not a settled product or
> technical decision. Authority: none. This file does not replace `PRD.md`, `SPEC.md`,
> `TASKS.md`, or any ADR. Use it to recover the direction and current experiment, then
> revalidate scope before extending it.

## Why keep this note

AgentDesk already has a project-first Agent Feed whose durable objects are projects and
sessions. The open question is whether a second view can make persistent agent identities
and coordination easier to understand without inventing another backend or hiding the
sessions that already contain the real work.

The working thesis is:

**A Bot is a stable named identity with one owned execution environment. The environment is
an existing local project directory first; it may later be provisioned as a directory or a
VM. Provider sessions are executions associated with that Bot, not the Bot's identity.**

Bots still reuse the existing Agent Feed providers, sessions, transports, and transcripts.
The new durable state is the curated identity and its environment binding, not another agent
backend.

This is deliberately a direction rather than a settled design. The current PRD still
defers the richer multi-agent overview and attention model. Any implementation beyond the
small shell already present must deliberately reopen that scope and update the proper
source of truth.

## Current state

The Agent Panel sidebar now has two views and a first curated Bot registry:

- **Sessions** remains the default and continues to show the complete session catalog.
- **Bots** shows only explicitly curated Bots and keeps `No bots yet` when the roster is empty.
- `Add Bot` binds a user-facing name, optional HTTPS icon, role, description, labels, and
  metadata to one exact existing project directory. A new Bot starts with no sessions.
- Each Bot row has its own `+` action. Its picker contains only sessions that AgentDesk already
  correlates to that Bot's directory through the session catalog cwd.
- Attached sessions render under the Bot. Clicking one opens the existing feed and composer.
- The registry persists to a protected revisioned `bots.json`, and the panel follows its SSE
  projection through the existing authenticated relay.
- A granted Pi-backed Bot receives the provider-neutral `add_bot` adapter when its runtime opens.
- Switching to an empty Bots view still clears the session workspace. Returning to Sessions
  restores the previously selected session.

There is still no separate Bot backend, automatic inbox selection, cross-Bot messaging,
room, environment provisioner, repair operation, or canonical inbox selection.

Relevant current surfaces are:

- `packages/AgentPanel/Web/src/features/sidebar/AgentSidebar.tsx`
- `packages/AgentPanel/Web/src/features/bots/`
- `packages/AgentPanel/Web/src/app/AgentPanelApp.tsx`
- `agent-feed/wire/bot.ts`
- `agent-feed/sidecar/src/bots/`
- `agent-feed/sidecar/src/http/botRoutes.ts`

## Near direction: message an existing project

Before building Bot rooms or autonomous Bot-to-Bot conversation, add the smallest useful
control capability: send a message into an existing project through one of that project's
existing send-capable sessions.

The “Chief of Staff” idea is currently a coordination metaphor, not a new backend or a
special runtime object. It means the surface should help the user direct work to the right
existing session while preserving where the message actually went.

Working constraints:

1. The target must resolve to an explicit existing session that supports sending.
2. The UI must show the chosen destination before sending.
3. It must not silently choose the newest session and call that the project's inbox.
4. Unsupported transcript-only sessions remain viewable and clearly non-sendable.
5. The resulting message and response stay in the ordinary session history.

The exact target-selection interaction is still open. It could be a remembered explicit
project destination, a session picker at send time, or a separately pinned project inbox.
That choice should be made before adding an API that bakes in accidental routing behavior.

## Rough baseline: provider-neutral curated Bots with a local environment

The first Bot primitive should register a deliberate name and role, then bind that identity
to its own local execution directory. It should not create a Pi session, imply that any
provider owns Bot identity, or import every catalog session into the Bots tab.

The Sessions tab is the exhaustive machine inventory. The Bots tab is a small user-curated
roster. For example, the user may bind Bots to the existing project directories for
`chatbot`, `agent-desk`, `harbor`, and `oss-agent`, give each a meaningful name, and leave
hundreds of unrelated or unnamed sessions visible only under Sessions.

For this curated stage, “owns a directory” means one Bot has the exclusive Bot binding for
one existing project directory. AgentDesk does not copy, move, or clone that directory.
This is exclusive Bot identity, not exclusive filesystem access by AgentDesk.
Later provisioning may create a fresh directory or VM, but that is a separate lifecycle
operation from registering the Bot.

The proposed shape is one provider-neutral command with several possible adapters:

```text
User curation UI/API --------\
                              +--> AddBot command --> BotRegistry --> BotStore --> bots SSE --> panel
Provider tool adapter -------/                         `-- claim directory in ProjectCatalog

Bot-row session picker ----------> AttachBotSessions --> BotRegistry
                                                        `-- validate cwd in SessionCatalog
```

`BotRegistry` owns validation, authorization, idempotency, persistence, and publication.
An HTTP route or a future provider tool adapter calls it in process. Neither adapter owns a
second implementation of Bot creation.

Hermes does not have a separate Bot registry. Its desktop create dialog calls
`profiles.create`, and Bot Mode projects the existing durable Profile primitive:

- [Hermes Bot Mode](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/bot-mode.md),
  no date verifiable: a Bot is a Profile, and the UI configures that Profile.
- [Hermes profile API](https://github.com/NousResearch/hermes-agent/blob/main/hermes_cli/web_routers/profiles.py),
  no date verifiable: `POST /api/profiles` delegates to the same profile creation function.
- [Hermes #90319](https://github.com/NousResearch/hermes-agent/issues/90319), opened August
  19, 2026: proposes an opt-in, agent-callable `profile_manage` tool but remains open.
- [Hermes #89239](https://github.com/NousResearch/hermes-agent/issues/89239), opened August
  18, 2026: records the current failure mode where a request to create Bots produces cron
  jobs instead.

AgentDesk has provider-neutral projects and sessions but no equivalent durable Profile
primitive. Its first cut therefore needs a small identity and environment record over those
existing resources rather than a new provider runtime.

### Hermes comparison: what to borrow and what not to copy

Hermes treats a profile directory as both registry membership and the runtime home:

```text
~/.hermes/profiles/<canonical-name>/
  profile.yaml       display name and namespaced Bot Mode UI metadata
  config.yaml        runtime configuration
  state.db           sessions, including the canonical `Bot Chat`
  memories/ skills/ workspace/ logs/ ...
```

`profiles.list` discovers those directories. `profile.yaml` is written atomically and carries
revisioned `ui_meta`, while sessions remain in the profile's SQLite state. Bot Mode resolves its
canonical `Bot Chat` from the database rather than persisting a client-owned session pointer.
The desktop roster periodically refetches the profile list; it does not use an SSE Bot registry.

That ownership model does not transfer directly to AgentDesk. AgentDesk's first Bots bind existing
project directories, and most existing directories and sessions must remain outside the curated
roster. Directory existence therefore cannot mean Bot membership. `bots.json` remains the one
authoritative allowlist, and each record stores only the source-qualified references explicitly
attached by the user.

The parts worth carrying over are stable canonical identity separate from display name, small
namespaced presentation metadata, atomic durable writes, server-derived roster views, and
source-qualified identity. AgentDesk improves the update path with an authenticated SSE snapshot
instead of polling. If a later Bot is provisioned into an AgentDesk-owned directory or VM, that
environment can become a stronger runtime home without changing the curated identity contract.

### First-cut resource

Separate the stored user decision from the derived live view:

```ts
type BotSessionRef = {
  source: SourceId;
  sessionId: string;
};

type BotEnvironment = {
  kind: "directory";
  path: string;
};

type BotRecord = {
  botId: string;
  name: string;
  iconUrl?: string;
  environment: BotEnvironment;
  sessionRefs: BotSessionRef[];
  metadata: {
    role?: string;
    description?: string;
    labels: string[];
    custom: Record<string, string>;
  };
  grants: Array<"add_bot">;
  createdAt: number;
  createdBy:
    | { kind: "user" }
    | { kind: "bot"; botId: string };
};

type BotView = BotRecord & {
  environmentAvailability: "available" | "missing";
  sessions: SessionSummary[];
  missingSessionRefs: BotSessionRef[];
};

type BotStoreSnapshot = {
  version: 2;
  revision: number;
  bots: BotRecord[];
};
```

This is now the baseline wire shape, while its product status remains experimental. The
load-bearing distinctions are:

- `botId` is stable identity. A display name is not identity.
- `environment` is the Bot's execution home. The first implementation has only the
  `directory` kind, whose path is also the current Agent Feed project key.
- One directory may be bound to only one Bot. That is the ownership boundary that can later
  be replaced by a provisioned directory or VM environment.
- `sessionRefs` begins empty. Session attachment is a separate explicit operation on an
  existing Bot, so creating identity never implies selecting or creating provider work.
- Every attached reference must resolve to a session whose catalogued cwd equals the Bot's
  directory. The registry never guesses by title, recency, or provider.
- `source` uses the existing Agent Feed `SourceId`, so Claude, Codex, Pi, and later sources
  travel through the same model.
- `name` is required and user-authored. It is the curated identity missing from the raw
  session catalog.
- `role` is untrusted presentation and intent text. It grants no authority and does not
  mutate the referenced provider session's prompt.
- Environment and session availability are derived independently so a moved directory and
  missing transcripts are distinguishable.
- Sendability is derived independently from each current session summary. It is not stored
  as a second mutable truth.
- A missing directory or session leaves a visible broken reference that can be repaired. It
  does not silently delete the Bot or retarget it.
- The first cut permits several explicit attached sessions per Bot, selected through its own
  row action. Other sessions in the directory remain ordinary entries under Sessions.
- Sessions remain authoritative and continue to appear under Sessions. Bots never hide or
  rename the underlying transcript record.

The initial invariant prevents one directory being bound to two Bots. Because directory binding
is exclusive, a session correlated by cwd can belong to only that directory's Bot.

### `add_bot` command, independent of its caller

`add_bot` means create a named identity around one explicitly selected existing project directory.
It does not select a session, provision a runtime, or send a founding prompt.

```ts
type AddBotCommand = {
  requestId: string;
  name: string;
  iconUrl?: string;
  directoryPath: string;
  metadata?: BotMetadata;
};
```

The registry resolves the submitted directory against the current AgentDesk project catalog.
It rejects an unknown directory, duplicate directory binding, or duplicate normalized Bot name.
It generates `botId`, `environment`, `createdAt`, and `createdBy`; callers do not provide them.

Session attachment is a separate command:

```ts
type AttachBotSessionsCommand = {
  requestId: string;
  sessionRefs: BotSessionRef[];
};
```

The registry resolves every reference in the current session catalog and atomically rejects the
whole command if any session is unknown, already attached, or correlated to a different cwd.

If a fresh directory or VM is wanted later, a separate environment provisioner should
produce the environment reference before or as an orchestrated step around `add_bot`.
Provider session creation remains another separate operation. Keeping registration,
environment provisioning, and provider execution distinct prevents provider or VM lifecycle
from leaking into the Bot registry.

### Chief of Staff authority

The first Chief of Staff can itself be a curated Bot backed by Claude, Codex, Pi, or another
source. Its permission to call `add_bot` is an explicit policy grant on the curated record,
separate from presentation metadata and provider identity.

A provider-specific tool adapter captures the invoking session, resolves it to the Bot that
has that session attached, and asks a provider-neutral authorizer whether that Bot may add roster
entries. The model cannot claim a caller Bot ID in `AddBotCommand`. Newly curated Bots do
not inherit the Chief of Staff grant.

The first implementation exposes the same command through the authenticated user UI/API and a Pi
custom-tool adapter. The user API may grant `add_bot` to a curated Bot. The adapter is installed
only for a Pi session whose Bot record carries that grant, and it rechecks authorization when the
tool executes. Agent-created Bots receive no grants, so management authority is not inherited.

### Server API and live UI update

Use resource-oriented endpoints around the same `BotRegistry`:

```text
GET  /api/bots
GET  /api/bots/stream
POST /api/bots
POST /api/bots/:botId/sessions
```

`POST /api/bots` accepts `AddBotCommand` and returns `201` with the resulting `BotView`.
`POST /api/bots/:botId/sessions` accepts `AttachBotSessionsCommand` and returns the updated
view. Expected errors are `400` for invalid input, `404` for an undiscovered Bot, directory,
or session, `409` for a duplicate name, claimed directory, cross-directory attachment,
duplicate session reference, or idempotency conflict, and `500` for a durable-store failure.

`GET /api/bots/stream` is SSE. It sends an initial `BotStoreSnapshot`, then a new revisioned
snapshot after each durable store change. The panel owns one subscription at app scope, as
it already does for inventory, and passes the current roster to the sidebar. The panel does
not poll. Concurrent stable and dev sidecars share the machine-level file, serialize writes
with a bounded lock, and poll only its revision so a write from the other process reaches an
already-open stream. The current empty-Bots behavior remains: when the curated roster is
empty, both the sidebar list and middle workspace are empty.

The sidebar renders only curated `BotRecord` entries, enriched into `BotView` values from
current inventory. A Bot row shows its identity and directory, followed only by explicitly
attached sessions. The same sessions remain visible under Sessions.

The first curation interaction is split deliberately:

1. `Add Bot` opens a project picker backed by the existing AgentDesk inventory.
2. Select one unclaimed project directory, provide the Bot name and optional presentation
   metadata, then submit `AddBotCommand`.
3. The new Bot appears with `No sessions attached`; the middle panel remains empty.
4. Use that Bot row's `+` action to open its session picker.
5. The app subscribes only to that Bot directory and offers the sessions AgentDesk already
   correlates through cwd. Already attached sessions are disabled.
6. Submit one or more references through `AttachBotSessionsCommand`; the server validates the
   cwd correlation again and publishes the updated roster over SSE.
7. Click an attached session to open its existing transcript and composer.

When no Bots exist, the sidebar shows `Add Bot` while the middle panel remains empty. There is
no automatic projection of projects or sessions into the roster.

### Durable curation and idempotency

The Bot store follows the sidecar's atomic JSON pattern: write a protected
temporary file, flush it, and rename it over the snapshot. Each mutation increments
`revision`. A bounded cross-process lock protects the shared stable/dev roster from lost
updates, and stale lock recovery keeps a crashed sidecar from permanently blocking it.

The machine-level Bot store is authoritative for identity and environment bindings. The
directory does not also receive a mirrored `bot.json` in the first cut, because two writable
copies of the same identity would drift. Portability can move that authority later through
an explicit decision rather than adding a cache preemptively.

Adding a Bot or attaching a batch of curated references is one atomic store mutation after validation. A durable
idempotency entry binds the caller plus request ID to the normalized command and resulting
`botId`. Reusing a key with different input is a conflict; retrying the same input returns
the existing Bot.

The environment or an attached session may become unavailable after creation because a directory
or transcript moved, or a catalog adapter no longer discovers it. That is not a failed mutation.
The missing reference remains visible, and the user can later repair it through an explicit
update operation.

### Current ownership

- `agent-feed/wire/bot.ts`: Bot snapshot and API wire types.
- `agent-feed/sidecar/src/bots/botStore.ts`: atomic persistence and revision subscription.
- `agent-feed/sidecar/src/bots/botRegistry.ts`: catalog resolution, authorization,
  validation, and idempotent curation.
- `agent-feed/sidecar/src/http/botRoutes.ts`: HTTP and SSE adapters.
- Provider adapters: optional `add_bot` tool exposure that translates into the shared
  command without owning Bot behavior.
- `server.ts`: construct one store and registry, then inject them into routes and adapters.
- `SidecarDataSource` and `AgentPanelApp`: subscribe once and render the roster projection.

This requires no separate provider backend, WebRTC lane, QUIC message, direct public URL,
or Swift schema. The existing authenticated generic HTTP relay is sufficient for the panel
surface. Provider tool integration stays outside the Bot domain primitive.

### Later environment form: VM

Do not implement a VM adapter or generalized environment framework in the directory-only
slice. The persisted environment is already discriminated by `kind`, so a later technical
decision can extend the concept without changing Bot identity:

```ts
type FutureBotEnvironment =
  | { kind: "directory"; path: string }
  | { kind: "vm"; vmId: string };
```

The VM reference is illustrative. Its provider, filesystem, lifecycle, connectivity, and
credential rules are intentionally undefined. The stable contract is that a Bot owns one
environment and sessions execute within it.

## Beyond the first cut: explicit inbox and richer projection

The baseline already projects several explicitly attached sessions under one stable Bot. Its
important properties are ownership and indirection:

- A Bot references sessions. It does not copy transcripts or runtime state.
- Sessions remain authoritative and complete in the Sessions view.
- No attached session is currently a canonical inbox. Sending to a Bot remains undefined until
  the user selects one explicitly or another routing contract is chosen.
- Clicking the Bot identity itself does not guess which conversation to open. The user clicks an
  attached session.
- A Bot may be view-only when none of its projected sessions supports input.

A useful Bot row may eventually show name, role, source, current status, latest activity,
active-session count, whether user attention is needed, and whether it can receive a
message. Those signals should be derived from existing session/provider capability where
possible, not maintained as a second mutable truth.

## Later capability: cross-Bot communication

Cross-Bot communication is more than projection. It requires a real coordination path in
the sidecar and an explicit provider capability.

The preferred direction is a structured operation such as `message_bot`, not parsing free
form prose and guessing that one Bot intended to contact another. A future send would:

1. Resolve the target Bot.
2. Resolve its explicit inbox session.
3. Validate that the provider/session is reachable and send-capable.
4. Send through the existing backend adapter.
5. Return a visible receipt or failure linked to the underlying session.

Likely capability states include `reachable`, `working`, `needs-user`, `view-only`,
`offline`, and `failed`. The names and transition rules are not decided.

## Deferred: related Bots and rooms

Related-Bot grouping and Bot rooms are intentionally deferred. If reopened, the rough room
direction is:

- A room contains a small explicit roster, initially perhaps two to six Bots.
- The user addresses one Bot, mentioned Bots, or all Bots.
- Turns are serialized so each participating Bot can see prior room replies.
- A bounded round and reply budget prevents unbounded autonomous conversation.
- A Bot can reply, pass, mention another Bot, or ask for the user.
- Stop cancels active work where supported and prevents queued turns from starting.
- Failures remain visible instead of disappearing from the aggregate feed.
- Every room contribution links back to its underlying Agent Feed session, where full
  reasoning and tool activity remain available.

A room feed should be its own aggregate projection and should reuse the existing composer
and session presentation primitives. It should not masquerade as an ordinary
`ActivityEvent`, and it should not fork a second composer that later drifts from the
canonical one.

Possible sidecar endpoints discussed, only as a sketch:

```text
GET  /api/bots/stream
POST /api/bots/:botId/messages
GET  /api/bot-rooms/:roomId/stream
POST /api/bot-rooms/:roomId/turns
POST /api/bot-rooms/:roomId/stop
```

## Transport and Swift boundary

The working implementation preference is panel plus sidecar, with no new backend class and
no new transport. Agent Feed already relays generic authenticated HTTP and streaming data
between the panel and sidecar. New `/api/` resources should use that path unless evidence
shows that it cannot carry the required semantics.

This means the direction does not call for a separate WebRTC lane, a new QUIC message
family, or a direct public HTTPS service. Swift should remain unchanged unless the feature
requires a native capability that TypeScript and the existing authenticated relay cannot
provide. That keeps Agent Feed interaction work live-editable and targets zero Swift
compilation, reinstall, or app relaunch for this arc.

This baseline is now carried by the live relay. It is not a claim that every future
capability can never require a native change.

## Product lessons carried forward

The external references point in the same direction but should not be copied wholesale:

- [Introducing Grok Bot](https://x.ai/news/introducing-grok-bot), published August 11,
  2026, demonstrates persistent named teammates, a roster-oriented chat surface, and group
  conversation. AgentDesk should borrow the identity and attention metaphor, not Grok's
  cloud-computer runtime.
- [Grok Bot: More plans, same mission](https://x.ai/news/grok-bot-more-plans), published
  August 21, 2026, reinforces Bots as a product surface rather than a new transport concept.
- [Hermes Agent Bot Mode](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/bot-mode.md),
  no date verifiable, is the closer architectural reference: a Bot is a profile and Bot
  Mode is a UI over that profile primitive rather than a separate daemon or transcript
  store.

Recent Hermes issues expose failure modes AgentDesk should avoid:

- [#89347](https://github.com/NousResearch/hermes-agent/issues/89347), opened August 18,
  2026: users need to understand sessions grouped under Bots.
- [#91740](https://github.com/NousResearch/hermes-agent/issues/91740), opened August 21,
  2026: hiding Bot sessions from Sessions removes a necessary browsing path.
- [#92040](https://github.com/NousResearch/hermes-agent/issues/92040), opened August 22,
  2026: routing a Bot row to its newest session can make the canonical Bot chat
  unreachable.
- [#91334](https://github.com/NousResearch/hermes-agent/issues/91334), opened August 21,
  2026: a separate group composer can drift from the canonical composer.

The resulting invariants are simple: do not hide sessions, do not guess the inbox, reuse
the existing feed and composer primitives, and keep every Bot traceable to its environment
and every contribution traceable to the provider session that recorded it.

## Open decisions after the baseline

The current experiment chooses a shared machine-level store at
`~/Library/Application Support/agentdesk-agent-feed/bots.json`, with
`AGENT_FEED_BOTS_PATH` as the deployment override. The user bootstraps a Chief of Staff by
creating it for an existing directory, granting `add_bot`, then attaching an existing Pi
session from that directory. Those are revisable baseline choices, not settled product decisions.

1. Choose the actual initial curated roster through `Add Bot`, then attach its selected sessions.
2. Decide whether a newly granted Pi runtime should be refreshed immediately when it was
   already open, rather than receiving the tool on its next runtime open.
3. Define the repair interaction for an environment or session reference that becomes
   missing.
4. Decide whether named Bots reopen the deferred agent-native UX in `PRD.md`.
5. If rooms return, define ordering, budgets, receipts, cancellation, and persistence
   before choosing endpoints or wire shapes.

This file remains an anchor for discussion. Settled product scope belongs in `PRD.md`;
settled technical choices belong in an ADR and `SPEC.md`; active implementation work belongs
in `TASKS.md`.
