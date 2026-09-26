// Taking a session off a Bot, at two depths.
//
// Detaching forgets the reference. Retiring also ends the session and disposes of what its launch
// created for it. They are the same act at different depths rather than two acts, so the store
// mutation that makes "this Bot no longer holds that session" true lives here once and both
// registry methods wrap it.
//
// The teardown itself is NOT here. It is `git/sessionRetirement.ts`, which knows nothing about
// Bots, because a Bot is one place a reader retires a session from and a transcript view is
// another: a session nobody curated onto a Bot could not be retired at all if the operation lived
// on the Bot. What this file adds is the only question that is genuinely a Bot's -- does it hold
// this reference, and which checkout is it bound to -- which is the same division the fork path is
// moving to.

import type { BotRecord, BotSessionRef, RetiredBotSession } from "@agentdesk/agent-feed-wire";
import {
  disposeSessionWorktree,
  planSessionRetirement,
  type SessionRetirementPlan,
} from "@/git/sessionRetirement";
import { WorktreeError } from "@/git/worktree";
import type { BotStore, StoredBotSnapshot } from "@/bots/botStore";
import type { NormalizedRetire } from "@/bots/botCommands";
import { actorKey, appendIdempotency, commandSignature, priorBot, sessionKey } from "@/bots/botIdempotency";
import { withOffCanvasSessions } from "@/bots/botCanvas";
import {
  BotConflictError,
  BotNotFoundError,
  type BotActor,
  type BotRegistryCatalog,
  type BotSessionLauncher,
} from "@/bots/botTypes";

/**
 * Drops references from a Bot, refusing any it does not hold.
 *
 * The one implementation of the removal both commands make. Deliberately no catalog resolution:
 * what has to be true is that the Bot CLAIMS the reference, which the stored record is the only
 * authority on. Resolving would make a session the catalog has forgotten the one row that can never
 * be removed, and those are exactly the rows a reader wants gone.
 */
export function detachRefs(
  snapshot: StoredBotSnapshot,
  botId: string,
  refs: readonly BotSessionRef[],
  idempotencyKey: string,
  signature: string,
): { snapshot: StoredBotSnapshot; value: BotRecord } {
  const prior = priorBot(snapshot, idempotencyKey, signature);
  if (prior) return { snapshot, value: prior };
  const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
  if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
  const bot = snapshot.bots[index]!;
  const attached = new Set(bot.sessionRefs.map(sessionKey));
  const absent = refs.find((ref) => !attached.has(sessionKey(ref)));
  if (absent) throw new BotNotFoundError(`session ${sessionKey(absent)} is not attached to this Bot`);

  const removing = new Set(refs.map(sessionKey));
  const updated: BotRecord = withOffCanvasSessions(
    { ...bot, sessionRefs: bot.sessionRefs.filter((ref) => !removing.has(sessionKey(ref))) },
    // A session that leaves the Bot leaves its off-canvas list too. Kept, it would meet the session
    // again if it were ever attached back, as a row hidden on a card that never said so.
    (bot.offCanvasSessionRefs ?? []).filter((ref) => !removing.has(sessionKey(ref))),
  );
  const bots = [...snapshot.bots];
  bots[index] = updated;
  return {
    snapshot: {
      ...snapshot,
      revision: snapshot.revision + 1,
      bots,
      idempotency: appendIdempotency(snapshot, idempotencyKey, signature, bot.botId),
    },
    value: updated,
  };
}

/** The key and signature a retire is remembered by, in one place so the plan and the act agree. */
export function retireIdempotency(
  botId: string,
  command: NormalizedRetire,
  actor: BotActor,
): { key: string; signature: string } {
  return {
    key: `retire:${actorKey(actor)}:${command.requestId}`,
    signature: commandSignature({ botId, ...command }),
  };
}

export class BotSessionRetirer {
  constructor(
    private readonly store: BotStore,
    private readonly catalog: BotRegistryCatalog,
    private readonly launcher: BotSessionLauncher,
  ) {}

  /**
   * Ends these sessions, forgets them, and disposes of what their launches created.
   *
   * Panes are ended before the store is written and the disk is disposed of after. Ending first is
   * what stops a worktree being removed out from under a live shell. Detaching before the disk work
   * means a failure there leaves a session forgotten but recoverable by hand, rather than a dead
   * session the Bot still claims.
   */
  async retire(
    botId: string,
    command: NormalizedRetire,
    actor: BotActor,
  ): Promise<{ record: BotRecord; retired: RetiredBotSession[] }> {
    const snapshot = await this.store.snapshot();
    const bot = snapshot.bots.find((record) => record.botId === botId);
    if (!bot) throw new BotNotFoundError(`Bot "${botId}" was not found`);

    const { key, signature } = retireIdempotency(botId, command, actor);
    // Asked BEFORE the reference is checked, and the order is not cosmetic: the first run detached
    // it, so a replay reaching the check below would be told the Bot never held it. `detachRefs`
    // puts `priorBot` first for the same reason.
    //
    // A replay ends nothing and removes nothing, and says so with an empty list. Every act below is
    // destructive and none is idempotent on its own: run twice, the second `end` kills whatever
    // pane has since taken that name.
    const prior = priorBot(snapshot, key, signature);
    if (prior) return { record: prior, retired: [] };

    const held = new Set(bot.sessionRefs.map(sessionKey));
    const absent = command.sessionRefs.find((ref) => !held.has(sessionKey(ref)));
    if (absent) throw new BotNotFoundError(`session ${sessionKey(absent)} is not attached to this Bot`);

    const plans = await Promise.all(
      command.sessionRefs.map(async (ref) => ({
        ref,
        plan: await this.plan(bot.environment.path, ref, command),
      })),
    );
    const results = new Map<string, RetiredBotSession>(
      plans.map(({ ref }) => [sessionKey(ref), { ...ref, failed: [] }]),
    );

    for (const { ref } of plans) {
      const retired = results.get(sessionKey(ref))!;
      try {
        const pane = await this.launcher.end({ sessionId: ref.sessionId });
        if (pane) retired.endedPane = pane;
      } catch (error) {
        retired.failed.push({ step: "pane", reason: error instanceof Error ? error.message : String(error) });
      }
    }

    const record = await this.store.mutate((current) =>
      detachRefs(current, botId, command.sessionRefs, key, signature)
    );

    for (const { ref, plan } of plans) {
      const retired = results.get(sessionKey(ref))!;
      const outcome = await disposeSessionWorktree(plan, command);
      if (outcome.removedWorktree) retired.removedWorktree = outcome.removedWorktree;
      if (outcome.deletedBranch) retired.deletedBranch = outcome.deletedBranch;
      if (outcome.deletedRemoteBranch) retired.deletedRemoteBranch = outcome.deletedRemoteBranch;
      if (outcome.orphanedRemoteBranch) retired.orphanedRemoteBranch = outcome.orphanedRemoteBranch;
      // Appended rather than assigned: a pane that would not die is already recorded here.
      retired.failed.push(...outcome.failed);
    }
    return { record, retired: [...results.values()] };
  }

  /**
   * The Bot's half of the planning: where this session was working, and the Bot's own checkout.
   *
   * A session the catalog has forgotten is fine to end and forget -- that is the detach rule and it
   * holds here for the same reason -- but the catalog is the only thing that knows which directory
   * it was working in, so `worktree: "remove"` needs it and nothing else does. The refusal is a
   * Bot-shaped one; every refusal about the directory itself belongs to the plan below it.
   */
  private async plan(
    checkout: string,
    ref: BotSessionRef,
    command: NormalizedRetire,
  ): Promise<SessionRetirementPlan> {
    const projectPath = this.catalog.resolveSession(ref)?.projectPath;
    if (command.worktree === "remove" && !projectPath) {
      throw new BotNotFoundError(
        `session ${sessionKey(ref)} is not in the current catalog, so its worktree cannot be identified`,
      );
    }
    try {
      return await planSessionRetirement({ checkout, projectPath, disposals: command });
    } catch (error) {
      // The same translation `BotSessionStarter.prepare` makes for `prepareWorktree`: git's
      // refusals are the caller's to fix, so they arrive as a conflict rather than a fault.
      if (error instanceof WorktreeError) throw new BotConflictError(error.message);
      throw error;
    }
  }
}
