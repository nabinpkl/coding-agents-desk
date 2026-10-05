// Keeping every Bot session's title in its anchor shape, on this machine.
//
// A session's anchor is spent the moment it joins a Bot, but the title only follows when somebody
// renames it: a launch, a fork, the rename dialog, `set_task`. A session attached from outside,
// one that predates anchors, and one renamed by hand with `/rename` all keep a title that does not
// start with their name. This closes that gap for good rather than in a pass somebody has to
// remember to run.
//
// It is a queue in the sense that matters and not a stored one: what is owed is derived from the
// store and the catalog every time (a session whose title is not its anchor's shape), so there is
// no second record to drift. What is kept in memory is only WHEN each session was last asked, so
// a session that cannot take a rename is asked again when it next moves rather than on a timer.
//
// Two ways a rename waits, both answered by the same event. A stopped Claude session has no pane
// to type `/rename` into, and a running one may have unsent text in its composer. Either way the
// session is asked again once its transcript moves on -- which, for a stopped session, means it
// has started again. Writing the title into the transcript instead is deliberately not a fallback:
// it moves the title and leaves the session's address behind (`renameSession.ts` has why).
//
// Per machine, because the store is: each sidecar keeps its own Bots' titles and no other.

import type { BotSessionRef, SourceId } from "@agentdesk/agent-feed-wire";
import {
  backfillTaskText,
  formatBotSessionTitle,
  parseBotSessionTitle,
  refuseTaskText,
} from "@agentdesk/agent-feed-wire";
import type { BotStore, StoredBotSnapshot } from "@/bots/botStore";
import { sessionKey } from "@/bots/botIdempotency";
import type { BotRegistryCatalog } from "@/bots/botTypes";
import { spentAnchors } from "@/bots/sessions/botSessionLaunch";
import { allocateAnchors, type BotSessionRenamer } from "@/bots/sessions/botTitleNormalize";
import { sessionTitleRefusal } from "@/transcripts/session-ops/sessionTitle";

/**
 * The title a session should wear under its anchor, read off the title it wears now.
 *
 * Already in this anchor's shape reads back as its task. Anything else sheds the previous era's
 * trailing suffixes (`(fork 3)`) and becomes the task whole, so a hand-typed `/rename` survives as
 * the bracket rather than being thrown away. A task that cannot bracket, or would make the title
 * too long, is dropped and the session starts bare: the anchor is the half that matters.
 */
export function anchoredTitle(anchor: string, current: string): { title: string; dropped?: string } {
  const parsed = parseBotSessionTitle(current);
  const rawTask = parsed.anchor === anchor ? parsed.task : backfillTaskText(current);
  const fits = rawTask
    && !refuseTaskText(rawTask)
    && !sessionTitleRefusal(formatBotSessionTitle(anchor, rawTask));
  const task = fits ? rawTask : "";
  return {
    title: formatBotSessionTitle(anchor, task),
    ...(rawTask && !task ? { dropped: rawTask } : {}),
  };
}

export interface BotTitleQueueOptions {
  store: BotStore;
  catalog: BotRegistryCatalog;
  renamer: BotSessionRenamer;
  /** Sources the renamer has a mechanism for. Anything else keeps its title and is never asked. */
  renamable: (source: SourceId) => boolean;
  log?: (line: string) => void;
}

/** What this process last did about one session's title. */
interface Asked {
  /** The session's `lastEventAt` when it was asked: it is asked again only once that moves. */
  at: number;
  /** The rename was sent. It is not sent again until the title has matched once. */
  sent: boolean;
  /** Why it was refused, so a session that keeps moving and keeps waiting is logged once. */
  reason?: string;
}

export class BotTitleQueue {
  private latest: StoredBotSnapshot | null = null;
  private readonly asked = new Map<string, Asked>();
  private running: Promise<void> | null = null;
  private owed = false;
  private readonly stops: (() => void)[] = [];
  private readonly log: (line: string) => void;

  constructor(private readonly options: BotTitleQueueOptions) {
    this.log = options.log ?? ((line) => console.log(`agent feed bot titles: ${line}`));
  }

  /**
   * Starts listening, and runs once straight away.
   *
   * The store's subscription keeps its directory watch open for the life of the process, which is
   * the shape this repo wants of a watch under Bun anyway (AGENTS.md, "Reach for an event").
   */
  start(): void {
    this.stops.push(this.options.store.subscribe((snapshot) => {
      this.latest = snapshot;
      this.wake();
    }));
    this.stops.push(this.options.catalog.subscribe(() => this.wake()));
    this.wake();
  }

  stop(): void {
    for (const stop of this.stops.splice(0)) stop();
  }

  /** Resolves once no run is in flight or owed. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  private wake(): void {
    this.owed = true;
    if (this.running) return;
    const run = this.drain();
    this.running = run;
    // Cleared from outside the promise, so the clear always lands after the assignment above.
    void run.then(() => this.finished(run), (error: unknown) => {
      console.error("agent feed bot titles: a pass failed", error);
      this.finished(run);
    });
  }

  private finished(run: Promise<void>): void {
    if (this.running === run) this.running = null;
    // A wake that arrived between the last pass and this clear saw a run in flight and left.
    if (this.owed) this.wake();
  }

  private async drain(): Promise<void> {
    while (this.owed) {
      this.owed = false;
      await this.pass();
    }
  }

  private async pass(): Promise<void> {
    let snapshot = this.latest ?? await this.options.store.snapshot();
    if (snapshot.bots.some((bot) => bot.sessionRefs.some((ref) => !bot.sessionAnchors?.[sessionKey(ref)]))) {
      // Records from before anchors existed: spend theirs first-free, in one write.
      snapshot = await this.options.store.mutate((current) => {
        const taken = spentAnchors(current.bots);
        const next = {
          ...current,
          revision: current.revision + 1,
          bots: current.bots.map((bot) => ({
            ...bot,
            sessionAnchors: allocateAnchors(bot.sessionAnchors, bot.sessionRefs, taken),
          })),
        };
        return { snapshot: next, value: next };
      });
      this.latest = snapshot;
    }

    const holders = new Map<string, number>();
    for (const bot of snapshot.bots) {
      for (const ref of bot.sessionRefs) {
        holders.set(sessionKey(ref), (holders.get(sessionKey(ref)) ?? 0) + 1);
      }
    }
    for (const bot of snapshot.bots) {
      for (const ref of bot.sessionRefs) {
        const key = sessionKey(ref);
        const anchor = bot.sessionAnchors?.[key];
        // Held by two Bots means two anchors, and one title cannot wear both.
        if (!anchor || holders.get(key) !== 1) continue;
        await this.keep(ref, anchor);
      }
    }
  }

  private async keep(ref: BotSessionRef, anchor: string): Promise<void> {
    if (!this.options.renamable(ref.source)) return;
    const resolved = this.options.catalog.resolveSession(ref);
    if (!resolved) return;
    const key = sessionKey(ref);
    const { title, dropped } = anchoredTitle(anchor, resolved.summary.title);
    if (resolved.summary.title === title) {
      this.asked.delete(key);
      return;
    }
    const at = resolved.summary.lastEventAt;
    const before = this.asked.get(key);
    // A sent rename is fire-and-forget into a pane, so it is not sent twice: the title changing is
    // the answer. A refused one is asked again once the session has moved since.
    if (before && (before.sent || before.at >= at)) return;
    try {
      await this.options.renamer(ref, title);
      this.asked.set(key, { at, sent: true });
      this.log(`renamed ${key} to ${JSON.stringify(title)}${dropped ? `, dropping ${JSON.stringify(dropped)}` : ""}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.asked.set(key, { at, sent: false, reason });
      if (before?.reason !== reason) this.log(`${key} waits for ${JSON.stringify(title)}: ${reason}`);
    }
  }
}
