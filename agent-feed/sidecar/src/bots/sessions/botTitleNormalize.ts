// Giving every attached session its anchor-shaped title, in one pass.
//
// Split from the registry because the registry is about what a command may do and this is one
// act with one owner: spend every missing anchor in a single mutation, then rename each
// session through whatever mechanism its source needs. The registry keeps a one-line delegate.

import type { BotRecord, BotSessionRef, RenamedBracket } from "@agentdesk/agent-feed-wire";
import {
  backfillTaskText,
  firstFreeAnchor,
  formatBotSessionTitle,
  parseBotSessionTitle,
  refuseTaskText,
} from "@agentdesk/agent-feed-wire";
import type { BotStore } from "@/bots/botStore";
import { sessionKey } from "@/bots/botIdempotency";
import { spentAnchors } from "@/bots/sessions/botSessionLaunch";
import { sessionTitleRefusal } from "@/transcripts/session-ops/sessionTitle";
import {
  BotConflictError,
  BotInvalidError,
  BotNotFoundError,
  type BotRegistryCatalog,
} from "@/bots/botTypes";

/**
 * Renames one session to the composed title, by whatever mechanism its source needs.
 *
 * Injected rather than imported because the mechanisms live in different owners: Claude's rename
 * runs `/rename` in its pane, opencode's PATCHes its serve through its backend. A source with no
 * mechanism never reaches this -- the pass reports it instead.
 */
export type BotSessionRenamer = (ref: BotSessionRef, title: string) => Promise<void>;

/** What the pass did with one attached session. */
export interface TitleNormalization {
  botId: string;
  source: BotSessionRef["source"];
  sessionId: string;
  /** The anchor spent for this session, whether or not the rename landed. */
  anchor: string;
  /** The full title it was renamed to, or the anchor when it starts bare. */
  title: string;
  status: "renamed" | "already" | "skipped";
  reason?: string;
}

/**
 * Spends anchors for refs that hold none, first-free over the taken set.
 *
 * Pure, so the attach path and the pass share it: both hand the taken set they already hold and
 * store what comes back.
 */
export function allocateAnchors(
  existing: Record<string, string> | undefined,
  refs: readonly BotSessionRef[],
  taken: Set<string>,
): Record<string, string> {
  const anchors: Record<string, string> = { ...(existing ?? {}) };
  for (const ref of refs) {
    const key = sessionKey(ref);
    if (anchors[key] === undefined) {
      anchors[key] = firstFreeAnchor(taken);
      taken.add(anchors[key]!);
    }
  }
  return anchors;
}

/**
 * Renames one session's bracket task: the single completion path every `set_task` front door
 * forwards to.
 *
 * The caller names the session and the task text only. The anchor is resolved here -- stored, or
 * spent first-free when the record predates anchors -- and the composed title renames through the
 * injected mechanism. Exactly one Bot must hold the session: two anchors name it and one title
 * cannot wear both, so that refusal names the Bots instead of guessing.
 */
export async function renameBracketTitle(
  store: BotStore,
  catalog: BotRegistryCatalog,
  ref: BotSessionRef,
  task: string,
  renamer: BotSessionRenamer,
): Promise<RenamedBracket> {
  const key = sessionKey(ref);
  const record = await store.mutate((snapshot) => {
    const holders = snapshot.bots.filter((bot) =>
      bot.sessionRefs.some((held) => sessionKey(held) === key)
    );
    if (holders.length === 0) throw new BotNotFoundError(`session ${key} is not attached to any Bot`);
    if (holders.length > 1) {
      throw new BotConflictError(
        `session ${key} is held by ${holders.map((bot) => `"${bot.name}"`).join(" and ")}, so no one anchor names it`,
      );
    }
    const bot = holders[0]!;
    const anchor = bot.sessionAnchors?.[key] ?? firstFreeAnchor(spentAnchors(snapshot.bots));
    const bots = snapshot.bots.map((one) =>
      one.botId === bot.botId
        ? { ...one, sessionAnchors: { ...(one.sessionAnchors ?? {}), [key]: anchor } }
        : one
    );
    return {
      snapshot: { ...snapshot, revision: snapshot.revision + 1, bots },
      value: { botId: bot.botId, anchor },
    };
  });

  const taskRefusal = task ? refuseTaskText(task) : null;
  if (taskRefusal) throw new BotInvalidError(`task: ${taskRefusal}`);
  const title = formatBotSessionTitle(record.anchor, task);
  const refusal = sessionTitleRefusal(title);
  if (refusal) throw new BotInvalidError(`task: ${refusal}`);
  const resolved = catalog.resolveSession(ref);
  if (!resolved) throw new BotNotFoundError(`session ${key} is not in the current catalog`);
  if (resolved.summary.title === title) {
    return { botId: record.botId, anchor: record.anchor, title, status: "already" };
  }
  await renamer(ref, title);
  return { botId: record.botId, anchor: record.anchor, title, status: "renamed" };
}

/**
 * Brings every attached session's title into the anchor shape, spending anchors first.
 *
 * The ANCHOR comes from this store (first-free over every Bot, spent once in a single mutation),
 * while the TASK is read off the session's current title and the rename itself runs in the
 * session's own pane. A rename that fails leaves its anchor stored, so the next pass reuses the
 * same name rather than spending another. Sessions no source can rename, and references the
 * catalog has forgotten, keep their anchors and are reported rather than failed.
 */
export async function normalizeBotTitles(
  store: BotStore,
  catalog: BotRegistryCatalog,
  renamer: BotSessionRenamer,
): Promise<TitleNormalization[]> {
  const anchored = await store.mutate((snapshot) => {
    const taken = spentAnchors(snapshot.bots);
    const bots = snapshot.bots.map((bot) => ({
      ...bot,
      sessionAnchors: allocateAnchors(bot.sessionAnchors, bot.sessionRefs, taken),
    }));
    return {
      snapshot: { ...snapshot, revision: snapshot.revision + 1, bots },
      value: bots,
    };
  });

  const normalizations: TitleNormalization[] = [];
  for (const bot of anchored) {
    for (const ref of bot.sessionRefs) {
      const anchor = bot.sessionAnchors![sessionKey(ref)]!;
      const entry = {
        botId: bot.botId,
        source: ref.source,
        sessionId: ref.sessionId,
        anchor,
        title: anchor,
      };
      const resolved = catalog.resolveSession(ref);
      if (!resolved) {
        normalizations.push({ ...entry, status: "skipped", reason: "not in the catalog" });
        continue;
      }
      // Already in this anchor's shape reads back as its task; anything else sheds the previous
      // era's trailing suffixes rather than nesting them.
      const parsed = parseBotSessionTitle(resolved.summary.title);
      const rawTask = parsed.anchor === anchor ? parsed.task : backfillTaskText(resolved.summary.title);
      // A task that cannot bracket is dropped rather than nested: the anchor is the half that
      // matters, and the reason says what was left behind.
      const task = rawTask && !refuseTaskText(rawTask) ? rawTask : "";
      const title = formatBotSessionTitle(anchor, task);
      const note = rawTask && !task
        ? `task ${JSON.stringify(rawTask)} cannot bracket, starting bare`
        : undefined;
      if (resolved.summary.title === title) {
        normalizations.push({ ...entry, title, status: "already" });
        continue;
      }
      try {
        await renamer(ref, title);
        normalizations.push({ ...entry, title, status: "renamed", ...(note ? { reason: note } : {}) });
      } catch (error) {
        // One stuck session must not stop the pass.
        normalizations.push({
          ...entry,
          title,
          status: "skipped",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return normalizations;
}
