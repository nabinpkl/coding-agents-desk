# List all tailnet iOS devices in the pairing picker, with pre-arm

Date: 2026-07-02
Status: implemented
ADR: ADR-0049 (refines ADR-0019)

## Problem

The Mac pairing picker (ADR-0019, R55) lists only tailnet iOS peers whose AgentDesk client answers a whois probe. The client's offer-port listener runs only while the app is foregrounded, so a phone with the app closed never appears and cannot be picked. The user wants the host to list every iOS device on the tailnet and let any of them be selected, including ones whose app is closed, which should then pair automatically once the app opens.

This is the first slice of a larger pairing revisit. Flipping the dial direction (phone-dials-Mac), first-contact host-address bootstrap, and a tailnet-source-IP pre-approval binding are explicitly out of scope here and deferred to a follow-up ADR.

## Scope

In:
- List all online iOS tailnet peers, not just whois responders.
- Per-row status: "ready" (app answered whois) vs "app not open".
- Preselecting a closed-app device persists a pre-arm and auto-completes pairing when the app comes up.

Out (deferred):
- Phone-dials-Mac flip; first-contact bootstrap; source-IP pre-approval binding.

Host-only change. No client change, no offer-wire change, no nonce-model change.

## Design

### Listing (was: whois-gated)

`AppDelegate.showDevicePicker()` still filters `tailnetDiscovery.peerDevices()` to `isIOS && online`, then probes every candidate concurrently with `TailnetIdentityProber`. The probe no longer filters the list; it builds a `readyNames: [ipv4: displayName]` map of the peers that answered. `PairablePeer.rows(candidates:readyNames:)` (pure, unit-tested) resolves each candidate into a row:

- answered whois -> `displayName` = client-reported name, `ready = true`
- did not answer -> `displayName` = tailnet name (often "localhost"), `ready = false`

Rows sort ready-first, then alphabetically. The picker draws every row; not-ready rows are labelled "· app not open" and remain pickable.

### Row type

`PairablePeer { displayName, os, ipv4, ready }` is the picker row, distinct from the raw `TailnetDeviceOption { hostname, os, ipv4, online }`. This keeps the tailnet parser pure (it cannot know AgentDesk readiness) and makes enrichment a testable function.

### Pre-arm (closed-app pick)

Picking a `ready` device is the unchanged immediate path: `sendOffer(toIPv4:name:)` mints a nonce, marks it pre-approved, pushes the offer, and bounds the dial-back with the existing 30s timeout.

Picking a not-ready device calls `preArm`:

1. Persist a `PreArmedTarget { ipv4, name, armedAt, expiresAt }` to `pre-armed-targets.json` (Application Support, beside the paired-devices store), keyed by IPv4, TTL `Config.preArmTTL`.
2. Show the "Waiting for iPhone" popover (`.preArmed(name)`).
3. Start `startPreArmPoll(ipv4:name:)`: one task per IPv4 that whois-probes every `Config.preArmPollInterval` until the app answers, the intent expires, or the user cancels.

On answer, the poll calls `sendOffer` (the same push path as the ready pick), which first disarms the intent and cancels the poll. From there the existing ADR-0019 flow runs: offer push -> client dials back with the pre-approved nonce -> host auto-approves.

### Lifecycle

- `resumePreArms()` at launch restarts polls for still-live intents and prunes expired ones, so an intent survives a host restart mid-wait.
- `refreshConnectedState()` shows `.preArmed(name)` instead of `.idle` while an unpaired pre-arm is active, so reopening the popover shows the waiting state.
- `cancelPreArms()` (popover "Cancel") cancels all polls and clears all intents.
- `expirePreArm` fires when the TTL passes: disarm, drop the poll, fall back to the resting state.

### Why polling before pushing

The nonce TTL is 90s, so the offer cannot be minted at pick time for a phone that may open minutes later. Polling first means the nonce is minted only once whois confirms the client is listening, so the offer lands against a provably foregrounded client. This is strictly more reliable than ADR-0019's push-immediately model even setting the pre-arm feature aside.

## Files

- `host/AgentDeskHost/TailnetDiscovery.swift`: `PairablePeer` + `rows`.
- `host/AgentDeskHost/PreArmedTargetStore.swift`: durable store + pure `upsert`/`prune`.
- `host/AgentDeskHost/Config.swift`: `preArmedTargetsURL`, `preArmPollInterval`, `preArmTTL`.
- `host/AgentDeskHost/PopoverViewController.swift`: `.devicePicker([PairablePeer])`, `.preArmed(String)`, ready/app-not-open rows, Cancel.
- `host/AgentDeskHost/AppDelegate.swift`: list-all picker, ready-vs-pre-arm branch, `sendOffer`, poll, resume, cancel, expire.
- Tests: `PreArmedTargetStoreTests`, `PairablePeer.rows` cases in `TailnetDiscoveryTests`.

## Verification

`just check`: 326 tests pass, including the new `PreArmedTargetStoreTests` suite and the three `rows` cases. On-device confirmation (deferred to a user-approved run): pick a closed-app iPhone, see "Waiting for iPhone", open AgentDesk on it, pairing completes with no re-pick.

## Known limitations

- A closed-app device shows "localhost" + IPv4 until its app opens; the name self-heals on readiness.
- `activePreArmName` tracks a single displayed name; with multiple simultaneous pre-arms the popover shows the most recently armed one while all polls run.
- The push still depends on the client listener, which per ADR-0019 code comments is "unproven" over utun to a foregrounded sandboxed iOS app. If it proves unreliable, the follow-up flip (phone-dials-Mac) is the answer.
