---
status: accepted
date: 2026-07-02
---

# List all tailnet iOS devices in the pairing picker, with pre-arm for closed-app devices

## Context and Problem Statement

ADR-0019 (R55 refinement) built the Mac pairing picker so it lists only tailnet iOS peers whose AgentDesk client answers a whois probe on the offer port. Because the client's `PairingOfferListener` runs only while the app is foregrounded (iOS tears the `NWListener` down on suspend), a device whose app is closed never answers whois and therefore never appears in the picker. The user cannot pick a phone that is not currently holding the app open. This touches `TailnetDiscovery`, `AppDelegate`/`PopoverViewController`, and adds a durable pre-arm store; it does not change the offer wire (`PairingOfferSender`, `PairingPayload`, offer port) or the pre-approval nonce model.

## Decision Drivers

- The picker should surface every iPhone actually reachable on the tailnet, not only the subset currently running the app, so the user can pick the target device the moment they think of it.
- A device picked while its app is closed must still pair without the user coming back to re-pick once they open the app.
- The offer push still requires the client's listener to be up; the design must not push into a void.
- No change to the offer wire or the nonce trust model (keep ADR-0019's crypto and pre-approval intact).

## Considered Options

- **Option A**: List all online iOS peers; whois only enriches names for ready devices; picking a closed-app device persists a pre-arm and a readiness poll fires the existing offer push when the app comes up.
- **Option B**: Keep the whois-gated list, but add a manual "add by IP" entry for closed-app devices.
- **Option C**: Flip the pairing direction so the iPhone dials the Mac, removing the offer-push foreground dependency entirely.

## Decision Outcome

Chose **Option A** because it satisfies "list every reachable iPhone" and "no re-pick" without touching the offer wire or the nonce model. Option B fails the "surface every device" driver: it still hides devices behind a manual step and leans on the user knowing tailnet IPs. Option C satisfies the drivers but is a far larger change to the offer/handshake direction and is deferred to a follow-up ADR; the pre-arm readiness poll here is deliberately a stepping stone that also de-risks it (if the auto-fired push proves unreliable, that is the signal to flip). A useful side effect of the poll: the host now pushes the offer only after whois confirms the client is listening, so the push lands when the client is provably foregrounded, which is strictly more reliable than ADR-0019's push-immediately-and-hope within a 30s window.

### Consequences

- Good, because a closed-app iPhone is now visible and pickable, and pairing completes automatically when the user opens the app on it.
- Good, because the offer now fires against a confirmed-listening client rather than blindly, improving push reliability without any wire change.
- Bad, because a closed-app device shows its tailnet name (often "localhost") plus IPv4 until its app opens and whois yields a real name. Accepted: the IPv4 disambiguates, and the name self-heals on readiness.
- Neutral, because a new durable file (`pre-armed-targets.json`) joins the paired-devices store in Application Support; it is pruned by TTL and on completion so it cannot grow unbounded.

### Confirmation

`PairablePeer.rows` is unit-tested (lists all candidates, ready-first ordering, whois-name-when-ready). `PreArmedTargetStore` upsert/prune/persistence is unit-tested. Both run under `just check`. On-device confirmation: picking a closed-app iPhone shows the "Waiting for iPhone" popover, and opening AgentDesk on that phone completes pairing with no second pick.

## Relationship to ADR-0019

This refines ADR-0019's R55 discovery refinement only. ADR-0019's decision that the whois reply names the device stands; what changes is that a non-answering peer is now listed (not dropped) and can be pre-armed. The Mac-initiated direction, the plain-TCP offer port, the offer payload, and the pre-approval nonce are unchanged.
