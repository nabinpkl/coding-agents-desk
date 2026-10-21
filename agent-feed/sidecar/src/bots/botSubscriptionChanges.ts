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
 * Identity for most of it, and that is the constraint: a session's last-event time and its token
 * counts move on an ordinary transcript write, so comparing them exactly would put this back to a
 * snapshot per write and reintroduce the flood the store's revision exists to stop. What this stream
 * owns is which references a Bot holds, which of them resolve, what each one is called, and what a
 * canvas card draws from it.
 *
 * Which includes the time and the activity under each card's title. They were left off on the
 * assumption that a panel hears them from the session catalog stream, and the canvas card does not:
 * it draws the session this stream hands it. Measured 2026-10-17 on a session working throughout,
 * 45 seconds of this stream carried its opening snapshot only, "ready" at 03:26:12, while a fresh
 * read said "live" at 03:26:54. So both are here, at the grain the card shows them. The activity
 * bin is compared as it is, because it moves between live, ready, paused and cold a few times an
 * hour rather than on every write. The time is compared to the MINUTE, because the card prints
 * hours and minutes: a session writing all minute costs one snapshot a minute, not one per write.
 *
 * `environmentAvailability` is here because it is a `stat` rather than a record, so it can move
 * without a `mutate` too: a Bot's directory deleted underneath it, which is news a card should hear.
 *
 * The title is here for the same reason, and it is the one content field on this list, so it is
 * worth the measurement rather than the assumption. A title LOOKS like it moves on every write:
 * Claude re-emits its generated title as a session goes on, and a rename in opencode is a PATCH
 * the serve does not even announce. Neither is a change of value. Replaying every record of every
 * transcript on this machine under the sidecar's own rule -- `customTitle ?? aiTitle`, last one
 * wins, a custom title never overwritten -- 55 sessions and 74,631 records moved a title 5 times,
 * one per ~15,000 records, and the worst single session moved it once in 2,222. Compared against
 * the same replay counting `lastEventAt`, which is what a write really does move, including a title
 * costs a repaint roughly every fifteen thousand writes. The cost is not zero, and this is the
 * field to drop first if it ever is: a rename that leaves a row showing the old name reads as a
 * rename that did nothing, and the reader has no other signal that it worked.
 *
 * The task is here for the same reason as the title, and it is cheaper still. A session writes a
 * `<task-state>` block once per piece of work it is handed, not per write, and the card draws it
 * under the title: left out, a new block reached the card only when something else in this
 * signature happened to move, so the card went on showing the task before. Keyed on the block's
 * time, so a block that repeats the last one's words still counts as the session saying it again.
 */
/** The grain a card prints a session's last activity at, and so the grain a change is noticed at. */
const MINUTE_MS = 60_000;

export function viewSignature(snapshot: BotSnapshot): string {
  return snapshot.bots
    .map((bot) =>
      [
        bot.botId,
        bot.environmentAvailability,
        bot.sessions
          .map((one) =>
            [
              one.source,
              one.sessionId,
              one.title,
              one.taskState?.at ?? "",
              // A status set, replaced or cleared (a new turn, a question answered) is news to a card.
              `${one.spokenStatus?.from ?? ""}${one.spokenStatus?.at ?? ""}`,
              one.activity,
              Math.floor(one.lastEventAt / MINUTE_MS),
            ].join(":"),
          )
          .sort()
          .join(","),
        bot.missingSessionRefs
          .map((ref) => `${ref.source}:${ref.sessionId}`)
          .sort()
          .join(","),
      ].join("~"),
    )
    .join("|");
}
