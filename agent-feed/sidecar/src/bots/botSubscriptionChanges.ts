// What counts as a change worth waking a registry subscriber for, which is not one question.
//
// The registry has two subscribers and they want opposite things, and for a long time one check
// served both. The hub publishes a Bot's MEMBERSHIP -- its name, its directory, which references it
// holds -- so the store's revision is the honest answer: every membership edit goes through
// `mutate`, and a catalog event that moves no Bot has nothing to say to it. That check was not
// optional, either. Without it this machine published its whole Bot list to the hub over a hundred
// times a minute, because the catalog broadcasts on every coalesced transcript write.
//
// A panel draws more than membership. It draws a row per resolved session and a row per unresolved
// reference, so for it a reference that started or stopped resolving IS a change, with nothing
// edited anywhere. Measured 2026-09-26, and this file exists because of it: a sidecar restart left
// the catalog half-reconciled, a Bot's Claude references all read as `missing`, and the panel was
// handed that snapshot. The registry recomputed it correctly 7ms later and logged that it had --
// and the store's revision had not moved, so the correction was dropped and the panel kept drawing
// the rows, and the layout they took up, until the reader touched a Bot themselves. The registry's
// bad state was 7ms. The reader's was not bounded by anything.

import type { BotSnapshot } from "@agentdesk/agent-feed-wire";

/** Which question a subscriber is asking. See the file header for why there are two. */
export interface BotSubscribeOptions {
  /**
   * `"store"` (the default, and what the hub wants): only a `mutate` counts.
   * `"view"`: anything a subscriber can see counts, which adds a reference appearing in or leaving
   * `missingSessionRefs` and a session appearing in or leaving `sessions`.
   */
  onChange?: "store" | "view";
}

/**
 * The parts of a snapshot a subscriber DRAWS, and nothing else.
 *
 * Identity, not content, and that is the whole constraint. A session's title, token count and
 * activity all move on an ordinary transcript write, so comparing them would put this back to a
 * snapshot per write and reintroduce the flood the store's revision exists to stop. A panel already
 * holds the session catalog stream and the per-session streams, so everything that moves on a write
 * reaches it from there. What this stream owns is which references a Bot holds and which of them
 * resolve, and that is what has to be compared.
 *
 * `environmentAvailability` is here because it is a `stat` rather than a record, so it can move
 * without a `mutate` too: a Bot's directory deleted underneath it, which is news a card should hear.
 */
export function viewSignature(snapshot: BotSnapshot): string {
  return snapshot.bots
    .map((bot) => [
      bot.botId,
      bot.environmentAvailability,
      bot.sessions.map((one) => one.sessionId).sort().join(","),
      bot.missingSessionRefs.map((ref) => `${ref.source}:${ref.sessionId}`).sort().join(","),
    ].join("~"))
    .join("|");
}
