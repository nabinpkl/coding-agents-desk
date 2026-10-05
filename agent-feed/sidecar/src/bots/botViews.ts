// What the roster says: snapshots, subscriptions, and one Bot's resolved view.
//
// Publication, not mutation: nothing here writes. The registry answers commands by mutating
// through its starter, retirer and editor, then resolves through here, so a command's answer
// and the stream's next snapshot resolve the same way. Beside those collaborators rather than
// inside the registry, which stays the thin dispatcher that checks the actor and hands over.

import { stat } from "node:fs/promises";
import type {
  BotRecord,
  BotSnapshot,
  BotView,
} from "@agentdesk/agent-feed-wire";
import { noteBotSessionOutcomes, resolveBotSessions, type BotSessionOutcome } from "@/bots/sessions/botSessionResolution";
import { viewSignature, type BotSubscribeOptions } from "@/bots/botSubscriptionChanges";
import { type BotStore, type StoredBotSnapshot } from "@/bots/botStore";
import {
  type BotRegistryCatalog,
} from "@/bots/botTypes";
import { nextAnchor, spentAnchors } from "@/bots/sessions/botSessionLaunch";

async function directoryAvailability(path: string): Promise<"available" | "missing"> {
  try {
    return (await stat(path)).isDirectory() ? "available" : "missing";
  } catch {
    return "missing";
  }
}

export class BotViewer {
  constructor(
    private readonly store: BotStore,
    private readonly catalog: BotRegistryCatalog,
  ) {}

  async snapshot(): Promise<BotSnapshot> {
    return this.view(await this.store.snapshot());
  }

  async subscribe(
    listener: (snapshot: BotSnapshot) => void,
    onError?: (error: unknown) => void,
    options: BotSubscribeOptions = {},
  ): Promise<() => void> {
    const onChange = options.onChange ?? "store";
    let closed = false;
    let tail: Promise<void> = Promise.resolve();
    let lastRevision = -1;
    let lastVisible = "";
    // `force` is for the first snapshot, which nobody has emitted yet. Everything after that goes
    // through the change check, which is the whole point of having one.
    const emit = (force = false): void => {
      tail = tail.then(async () => {
        const snapshot = await this.snapshot();
        if (closed) return;
        // Only for a subscriber that reads it. The hub's emits are the frequent ones and the
        // signature is two sorts per Bot, which is nothing -- but nothing on the hottest path in
        // the product is better spent on a value that is then discarded.
        const visible = onChange === "view" ? viewSignature(snapshot) : lastVisible;
        const unchanged = snapshot.revision === lastRevision
          && (onChange === "store" || visible === lastVisible);
        if (!force && unchanged) return;
        lastRevision = snapshot.revision;
        lastVisible = visible;
        listener(snapshot);
      }).catch((error) => {
        if (!closed) onError?.(error);
      });
    };
    // Both signals go unforced, and the catalog one matters most. Which of them is worth answering
    // is `onChange`, and the whole reason there are two answers is in `botSubscriptionChanges.ts` --
    // including why the store's revision is right for the hub and wrong for a canvas, and what it
    // cost when one check tried to serve both.
    const stopStore = this.store.subscribe(() => emit());
    const stopCatalog = this.catalog.subscribe(() => emit());
    try {
      const initial = await this.snapshot();
      lastRevision = initial.revision;
      lastVisible = viewSignature(initial);
      listener(initial);
    } catch (error) {
      stopStore();
      stopCatalog();
      throw error;
    }
    // No timer: the store watches its own file, so a change made by another process arrives as a
    // store event exactly like one made here. Both of these subscriptions are the whole signal.
    return () => {
      closed = true;
      stopStore();
      stopCatalog();
    };
  }

  /**
   * One Bot's view, for the callers that want a single record rather than a snapshot.
   *
   * Goes through `resolveRecord` so a command's answer resolves its references the same way a
   * snapshot does -- but says nothing, because a command answers one Bot and the log diffs a whole
   * snapshot. A line from here would report every other Bot's still-missing reference as resolved.
   */
  async viewRecord(record: BotRecord): Promise<BotView> {
    const snapshot = await this.store.snapshot();
    return (await this.resolveRecord(record, nextAnchor(spentAnchors(snapshot.bots)))).view;
  }

  /**
   * Resolves every Bot, then says what the misses were -- in that order, and the order is the
   * point. The log diffs "still missing" across a whole snapshot, so a per-Bot note would read
   * every other Bot's still-missing reference as resolved, once per Bot, on every broadcast.
   */
  private async view(snapshot: StoredBotSnapshot): Promise<BotSnapshot> {
    // One answer for every Bot: the next name is the machine's, not any one Bot's.
    const next = nextAnchor(spentAnchors(snapshot.bots));
    const resolved = await Promise.all(snapshot.bots.map((record) => this.resolveRecord(record, next)));
    noteBotSessionOutcomes(resolved.flatMap((one) => one.outcomes));
    return {
      // The STREAM's version, which is the wire's and not the store's: `BOT_STORE_VERSION` just
      // moved to 3 and this stays 2.
      version: 2,
      revision: snapshot.revision,
      bots: resolved.map(({ outcomes, view }) => view),
    };
  }

  private async resolveRecord(
    record: BotRecord,
    next: string,
  ): Promise<{ view: BotView; outcomes: BotSessionOutcome[] }> {
    const { outcomes, ...split } = await resolveBotSessions(
      record,
      (ref) => this.catalog.resolveSession(ref),
    );
    return {
      view: {
        ...record,
        environmentAvailability: await directoryAvailability(record.environment.path),
        ...split,
        nextAnchor: next,
      },
      outcomes,
    };
  }
}
