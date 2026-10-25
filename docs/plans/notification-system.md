# Notification System Plan

> Cross-platform notifications for AgentDesk: macOS host and iOS client.
> Plan only; no implementation until approved.

## 1. What this is for

The user runs agent sessions, voice recordings, and terminal tasks that outlive their attention. Today, noticing that a session finished or needs input requires the app to be open and the user to be looking at it. A notification system closes that gap: events worth the user's attention reach them on whichever device they are using, including when the iPhone app is backgrounded.

## 2. Current state

No notification infrastructure exists anywhere in the project:

- **iOS**: No `UNUserNotificationCenter` usage. No `BGTaskScheduler`. No remote notification registration. The only notification code is `KeyboardDictationNotification` (Darwin notifications for inter-process dictation commands, not user-facing).
- **macOS**: No `NSUserNotification` or `UNUserNotificationCenter` usage.
- **Sidecar**: No notification module. The sidecar is the event hub that owns agent sessions, voice, terminal, and workspace state — the right home for notification event sourcing.

The iOS app kills its QUIC session within ~1 second of backgrounding (PRD requirement). There is no persistent background channel to the iPhone.

## 3. Events worth notifying about

Ranked by how often the user would want to know without staring at the app:

| Priority | Event | Source | Why |
|---|---|---|---|
| P0 | Agent session phase changes to `complete` | sidecar `live/` | The most common "I was waiting for this" event |
| P0 | Agent extension prompt (select, confirm, input, editor) | sidecar Pi runtime | The session is blocked on the user; every second of delay is the user's |
| P1 | Agent session goes idle after being busy | sidecar | "It finished" without waiting for the next human turn |
| P1 | Voice recording ready for review | sidecar voice pipeline | The user walked away from the phone |
| P1 | Host disconnected / session unavailable | sidecar or client | Something went wrong; the user should know |
| P2 | Terminal session exit | sidecar `terminal/` | A long-running command finished |
| P2 | Workspace file conflict | sidecar `workspace/` | Needs user decision (Use Host / Keep Mine) |
| P2 | Approaching session idle-timeout | sidecar `idleSessionSweep` | Optional: "this session will close soon" |

Explicitly out of scope:
- Transcription/typing progress (too chatty)
- Agent token usage or cost alerts
- Multi-user or team notifications (single-user project)

## 4. Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Event sources (sidecar)                                 │
│  live/        agent session phase, extension prompts     │
│  terminal/    session exit                              │
│  voice/       recording ready                           │
│  workspace/   file conflicts                            │
└──────────────────────┬──────────────────────────────────┘
                       │ emits NotificationEvent
                       ▼
┌─────────────────────────────────────────────────────────┐
│ NotificationService (sidecar, new module)               │
│  - Deduplicates and rate-limits per device+event type   │
│  - Maintains bounded pending queue per device           │
│  - Three delivery paths:                                │
│      1. Foreground push over QUIC (real-time)           │
│      2. APNs silent push (background wake)              │
│      3. On-foreground fetch (poll when app opens)       │
│  - Tracks delivery acks and prunes delivered events     │
└──────┬──────────────────────┬───────────────────────────┘
       │ QUIC (foreground)     │ APNs (background)
       ▼                       ▼
┌──────────────┐     ┌────────────────────┐
│ iOS client   │     │ APNs               │
│ (foreground) │     │ (Apple push infra) │
│              │     │ wakes app briefly  │
│              │     │ with ~30s budget   │
└──────┬───────┘     └────────┬───────────┘
       │                        │ silent push
       │                        ▼
       │              ┌────────────────────┐
       │              │ iOS client         │
       │              │ (background)       │
       │              │ receives push,     │
       │              │ fetches pending,   │
       │              │ presents local     │
       │              │ notification       │
       │              └────────────────────┘
       ▼
┌─────────────────────────────────────────────────────────┐
│ UNUserNotificationCenter (local notifications, both OS)  │
│  - Categories with actions (View, Dismiss)              │
│  - Request authorization at app launch                  │
│  - Foreground presentation via delegate                 │
└─────────────────────────────────────────────────────────┘
```

The macOS host can present notifications directly via `UNUserNotificationCenter` (available macOS 10.14+) since the host process is always running. No APNs needed on the Mac side.

## 5. Delivery paths — tradeoffs

### Path 1: Foreground push over QUIC

When the iPhone app is connected, the sidecar pushes notification events in real-time over the existing authenticated input lane. The iOS app presents them as local notifications immediately.

- **Pros**: No new infrastructure, no internet dependency, real-time, free.
- **Cons**: Only works when the app is foregrounded and connected.
- **Verdict**: Always on. This is the primary path for the common case.

### Path 2: APNs silent push

When the sidecar has a notification-worthy event and the device is not connected, it sends a silent push (`content-available: 1`) via APNs. iOS wakes the app in the background, which fetches pending events from the sidecar and presents local notifications.

- **Pros**: Reliable background delivery. The standard approach. The user doesn't need to have the app open.
- **Cons**: Requires internet on the Mac side (the sidecar talks to `api.push.apple.com`). Requires an APNs auth key (.p8) from the Apple Developer account. Adds a server-side dependency to the sidecar. Silent pushes are throttled by Apple (a few per hour is fine for these use cases).
- **Verdict**: The right answer for the "user walked away from the phone" case, which is the entire point of notifications. The "no internet routing" constraint in the PRD applies to the app's own communication (Tailscale-only), not to whether the Mac can reach Apple's push servers — the same way the Mac can reach npm or GitHub for development.

### Path 3: On-foreground fetch

When the iPhone app opens (or returns to foreground), it fetches all pending events from the sidecar and presents them as local notifications. This catches anything that was missed.

- **Pros**: No APNs dependency. No internet requirement. Catches up after any gap.
- **Cons**: Doesn't help when the user never opens the app.
- **Verdict**: Always on as a safety net. Complements paths 1 and 2.

### Not recommended: BGTaskScheduler

iOS periodically wakes the app via `BGAppRefreshTask`, but the interval is controlled by iOS (typically 15+ minutes minimum, often much longer based on usage patterns). Too unreliable for "agent finished, come look now" events.

### Not recommended: Tailscale-based background delivery

iOS does not allow listening sockets in the background (except for specific entitlements like VoIP, which this app does not have). The Tailscale connection on the iPhone dies with the session. There is no way to push to the iPhone over Tailscale while it is backgrounded without APNs.

## 6. Implementation phases

### Phase 1: Local notification infrastructure (no APNs)

**iOS:**
- `AppDelegate`: Request `UNUserNotificationCenter` authorization at launch.
- `NotificationManager` (new): Wraps `UNUserNotificationCenter`, defines categories/actions, handles foreground presentation via `UNUserNotificationCenterDelegate`.
- Foreground push: Receive notification events on the existing QUIC input lane (new push frame type), present as local notifications.
- Foreground fetch: On app launch and foreground transition, fetch pending events from `GET /api/notifications/pending`, present them.

**macOS:**
- `UNUserNotificationCenter` registration in the host app lifecycle.
- Present notifications directly from the sidecar's HTTP API or from a local notification presenter in the host.

**Sidecar:**
- `NotificationService` (new module under `agent-feed/sidecar/src/notifications/`):
  - Subscribes to agent session events, terminal events, voice events.
  - Emits `NotificationEvent` with type, title, body, category, metadata.
  - Maintains per-device pending queue (bounded, in-memory).
  - `GET /api/notifications/pending` — fetch and clear pending events.
  - `POST /api/notifications/delivered` — ack delivery for pruning.
  - Foreground push: Emit notification events on the input lane to connected clients.

**Wire protocol:**
- New push frame on the input lane: `NotificationPush { id, category, title, body, metadata? }` (`t: "notification"`).
- No outer protocol version bump needed — this rides the existing input lane.

**Testing:**
- Unit tests for `NotificationService` event filtering, deduplication, rate limiting, queue bounds.
- Unit tests for iOS `NotificationManager` category registration and presentation logic (mocked `UNUserNotificationCenter`).

### Phase 2: APNs silent push

**Prerequisites:**
- APNs auth key (.p8) from the Apple Developer account, stored in the sidecar's config/secrets.
- App ID configured with Push Notifications capability in the Apple Developer portal.
- iOS app: Enable Push Notifications capability, register for remote notifications at launch, send the device token to the sidecar over QUIC.

**Sidecar:**
- `APNsClient` (new): Token-based authentication using the .p8 key, sends silent push notifications via HTTP/2 to `api.push.apple.com`.
- `NotificationService`: When emitting an event for a device that is not connected over QUIC, fall back to APNs silent push.
- Device token registration: `POST /api/notifications/register-device` (over QUIC, authenticated).

**iOS:**
- Register for remote notifications at launch (`application(_:didReceiveRemoteNotification:fetchCompletionHandler:)` in `AppDelegate`).
- On silent push receipt: fetch pending events from the sidecar (if QUIC is still alive briefly) or present a generic "New activity" local notification that opens the app.
- Send device token to the sidecar.

**Testing:**
- Mock APNs server or use the APNs sandbox environment.
- Test token registration, push sending, retry on failure.
- Test the fallback path: event -> not connected -> APNs -> wake -> fetch -> present.

### Phase 3: macOS host notifications

**macOS host:**
- Register for `UNUserNotificationCenter` authorization at host launch.
- A `NotificationPresenter` in the host that receives events from the sidecar (via HTTP polling or a lightweight local connection) and presents them as user notifications.
- Alternatively: The sidecar runs locally on the Mac; the host can call `UNUserNotificationCenter` directly since both are on the same machine. A thin Swift wrapper in the host app that the sidecar talks to over a local socket or HTTP.

**Note**: Since the sidecar is local to the Mac, the simplest approach is a small Swift helper in the host that exposes a local HTTP endpoint; the sidecar POSTs notification events to it, and the Swift code presents them via `UNUserNotificationCenter`. This avoids giving the sidecar a macOS presentation dependency.

### Phase 4: Notification management (optional, if needed)

- `GET /api/notifications/history` — recent notification history for a notification center UI.
- Per-category mute settings.
- Do-not-disturb schedule.
- "View" action deep-links to the relevant session/surface.

## 7. Key technical decisions

| Decision | Choice | Rationale |
|---|---|---|
| Event hub location | Sidecar | Already owns all event sources; single source of truth |
| iOS local notifications | `UNUserNotificationCenter` | Standard, works foreground and background, no server needed for local |
| Background delivery | APNs silent push | Only reliable way to reach a backgrounded iOS app |
| Foreground delivery | Push over existing QUIC lane | No new infra, real-time, free |
| Safety net | On-foreground fetch | Catches anything missed by paths 1 and 2 |
| macOS delivery | Sidecar -> local HTTP -> Swift `UNUserNotificationCenter` | Sidecar should not depend on AppKit/UNUserNotificationCenter; thin Swift bridge is cleaner |
| Rate limiting | Per-device, per-category, max 1 notification per 2 seconds | Avoids notification storms when many events fire at once |
| Deduplication | Same event type + same session + within 5 seconds = deduplicate | Prevents duplicate notifications for the same logical event |
| Pending queue | In-memory, bounded at 100 events per device, FIFO eviction | Simple; the sidecar restarts are rare and the on-foreground fetch is the safety net |
| APNs auth | Token-based (.p8 key) | Easier to manage than certificates, one key for all apps under the account |

## 8. Wire shapes (new)

On the input lane (protocol v16, no bump needed — rides existing lane):

```
NotificationPush {
  id: String,                    // unique event id
  category: "agent-complete" | "agent-prompt" | "agent-idle" |
            "voice-ready" | "host-unavailable" | "terminal-exit" |
            "workspace-conflict",
  title: String,                 // "Agent finished" / "Voice ready"
  body: String,                  // session name or detail
  metadata: { source?, sessionId?, projectPath? }  // for deep-linking
}                                // t: "notification"
```

HTTP resources (sidecar):

```
GET  /api/notifications/pending
  -> { events: [NotificationEvent] }   // fetch and clear pending queue

POST /api/notifications/delivered
  { eventIds: [String] }                // ack for pruning

POST /api/notifications/register-device
  { deviceToken: String, deviceName: String }  // APNs token registration
```

## 9. Open questions

1. **Does the Apple Developer account have Push Notifications enabled for the App ID?** This is a prerequisite for Phase 2. If not, Phase 1 and Phase 3 still deliver value (foreground + on-foreground fetch).

2. **Should notifications be user-configurable (per-category on/off)?** If so, where do settings live? The existing `SettingsViewController` on iOS and a settings surface on macOS would be the natural homes.

3. **Do you want a notification history/center in the app?** Or are notifications ephemeral (present and forget)? Ephemeral is simpler and matches the "come look now" use case.

4. **Is internet access from the Mac side acceptable for APNs?** The PRD's "no internet routing" constraint is about the app's own communication. APNs is a platform service the sidecar calls, similar to how the sidecar might call npm or a model API. Confirm this reading is correct.

5. **What is the notification priority for agent extension prompts vs session completion?** Extension prompts block the session and need a response; session completion is informational. Should prompts use a different notification sound or interruption level (iOS 26's `UNNotificationInterruptionLevel`)?

## 10. Files that will be touched

**Phase 1:**
- `client/AgentDeskClient/AppDelegate.swift` — notification authorization, foreground fetch
- `client/AgentDeskClient/NotificationManager.swift` (new) — local notification wrapper
- `agent-feed/sidecar/src/notifications/NotificationService.ts` (new) — event hub, pending queue, HTTP resources
- `agent-feed/sidecar/src/notifications/NotificationEvents.ts` (new) — event types, categories, rate limiting
- `agent-feed/sidecar/src/server.ts` — wire new HTTP resources and input-lane push
- Tests for both sides

**Phase 2:**
- `agent-feed/sidecar/src/notifications/APNsClient.ts` (new) — HTTP/2 APNs client
- `client/AgentDeskClient/AppDelegate.swift` — remote notification registration, silent push handling
- `agent-feed/sidecar/src/config/` — APNs key configuration

**Phase 3:**
- `host/AgentDeskHost/NotificationPresenter.swift` (new) — macOS local notification bridge
- `agent-feed/sidecar/src/notifications/MacDelivery.ts` (new) — HTTP POST to local presenter
