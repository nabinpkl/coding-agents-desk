// Spending anchors and renaming one session's bracket task.
//
// Split from the registry because the registry is about what a command may do, and these are the
// two acts every anchor-shaped title goes through: spend the name, then rename the session through
// whatever mechanism its source needs. `botTitleQueue.ts` keeps every title in that shape.

import type { BotRecord, BotSessionRef, RenamedBracket } from "@agentdesk/agent-feed-wire";
import {
  firstFreeAnchor,
  formatBotSessionTitle,
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
 * mechanism never reaches this: the title queue does not ask it.
 */
export type BotSessionRenamer = (ref: BotSessionRef, title: string) => Promise<void>;

/**
 * Spends anchors for refs that hold none, first-free over the taken set.
 *
 * Pure, so the attach path and the title queue share it: both hand the taken set they already hold and
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
