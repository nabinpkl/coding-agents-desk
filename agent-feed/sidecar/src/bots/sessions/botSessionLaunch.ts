// Bringing a session into existence for a Bot, and recording it once it exists.
//
// Split from the registry because the four decisions below are one act with one owner,
// while the registry around it is about what a command is allowed to do. Its methods
// still read `this.store` and `this.catalog`: they are the registry's own, handed over
// at construction so both halves write through the same store.

import type { BotRecord, BotSessionRef, StartedSession } from "@agentdesk/agent-feed-wire";
import {
  firstFreeAnchor,
  formatBotSessionTitle,
  refuseTaskText,
  taskFromText,
  titleTask,
} from "@agentdesk/agent-feed-wire";
import { anchorPool } from "@/config/configAnchors";
import { WorktreeError } from "@/git/worktree";
import {
  type ForkRewinder,
  launchSession,
  resolveMessageAnchor,
  SessionForkInvalidError,
} from "@/transcripts/session-ops/forkSession";
import type { MessageAnchor } from "@/transcripts/messageAnchor";
import { sessionTitleRefusal } from "@/transcripts/session-ops/sessionTitle";
import type { BotStore } from "@/bots/botStore";
import type { NormalizedLaunch } from "@/bots/botCommands";
import { sessionKey } from "@/bots/botIdempotency";
import { ensureSessionSlots } from "@/bots/sessions/botSessionSlots";
import { placeRefs } from "@/bots/sessions/botSessionOrder";
import { BotInvalidError } from "@/bots/botTypes";
import {
  BotConflictError,
  BotLaunchError,
  BotNotFoundError,
  type BotRegistryCatalog,
  type BotSessionLauncher,
  type ResolvedBotSession,
} from "@/bots/botTypes";

/** Every anchor already spent, across every Bot: allocation is first-free over this set. */
export function spentAnchors(bots: readonly Pick<BotRecord, "sessionAnchors">[]): Set<string> {
  const taken = new Set<string>();
  for (const bot of bots) {
    for (const anchor of Object.values(bot.sessionAnchors ?? {})) taken.add(anchor);
  }
  return taken;
}

/** The anchor this machine hands out next: first-free over the taken set, from its own pool. */
export function nextAnchor(taken: Iterable<string>): string {
  return firstFreeAnchor(taken, anchorPool);
}

export class BotSessionStarter {
  constructor(
    private readonly store: BotStore,
    private readonly catalog: BotRegistryCatalog,
    private readonly launcher: BotSessionLauncher,
    private readonly newSessionId: () => string,
    private readonly rewinder: ForkRewinder,
  ) {}

  /**
   * Starts a session for a Bot that already exists, saying what survived when it cannot.
   *
   * Split out because the two callers differ only in what they have already spent. Creating a Bot
   * has spent a name and a directory by the time it gets here; adding a session to one has spent
   * nothing, and its own failures are ordinary refusals raised before anything is written.
   */
  async launchOrExplain(
    bot: BotRecord,
    launch: StartingLaunch,
    newSessionId: () => string = this.newSessionId,
  ): Promise<StartedSession> {
    try {
      return await this.launchSession(bot, launch, newSessionId);
    } catch (error) {
      if (error instanceof BotLaunchError) throw error;
      throw new BotLaunchError(
        `Bot "${bot.name}" was created, but its session could not be started. ` +
          "Resend this request once the cause is fixed, or attach a session to " +
          `${bot.botId} by hand.`,
        { cause: error },
      );
    }
  }

  /**
   * Starts the session a launch asks for, in this Bot's directory.
   *
   * The four decisions a launch makes -- which directory it runs in, whether it starts empty or
   * from another session's context, what its first turn is, and which pane it lands in -- are made
   * once, in `transcripts/forkSession.ts`, because forking stopped being a Bot operation. What is
   * left here is the only part that is genuinely the Bot's: whether the session being forked is
   * one of ITS sessions, and how git's refusal reads to somebody who asked a Bot for a session.
   */
  async launchSession(
    bot: BotRecord,
    launch: StartingLaunch,
    newSessionId: () => string = this.newSessionId,
  ): Promise<StartedSession> {
    // A fork runs where its source runs unless it asked for a tree of its own, so a fork of a
    // session already in a worktree stays in that worktree rather than being pulled back into the
    // checkout it branched away from.
    const source = launch.from ? this.resolveOwnSession(bot, launch.from) : undefined;
    const anchor =
      launch.from?.eventId === undefined || source === undefined
        ? undefined
        : await this.resolveAnchor(launch.from.sessionId, launch.from.eventId, source);
    try {
      return await launchSession(
        {
          checkout: bot.environment.path,
          ...(source === undefined ? {} : { sourcePath: source.projectPath }),
          ...(launch.from === undefined ? {} : { from: launch.from.sessionId }),
          ...(anchor === undefined ? {} : { anchor }),
          title: launch.title,
          ...(launch.unnamed ? { unnamed: true } : {}),
          ...(launch.prompt === undefined ? {} : { prompt: launch.prompt }),
          ...(launch.worktree === undefined ? {} : { worktree: launch.worktree }),
          ...(launch.claudeMode === undefined ? {} : { claudeMode: launch.claudeMode }),
        },
        this.launcher,
        newSessionId,
        this.rewinder,
      );
    } catch (error) {
      // Said as a Bot conflict rather than passed through: the caller asked a Bot for a session,
      // and git's own wording about worktrees names nothing they can act on.
      if (error instanceof WorktreeError) throw new BotConflictError(error.message);
      throw error;
    }
  }

  /**
   * The message a fork starts before, resolved BEFORE anything is started, so a row that is not a
   * message is refused rather than answered with a running fork holding the whole conversation.
   */
  private async resolveAnchor(sessionId: string, eventId: string, source: ResolvedBotSession): Promise<MessageAnchor> {
    if (!source.transcriptPath) {
      throw new BotNotFoundError(`session claude:${sessionId} has no transcript to fork a message from`);
    }
    try {
      return await resolveMessageAnchor({ eventId }, sessionId, source.transcriptPath);
    } catch (error) {
      if (error instanceof SessionForkInvalidError) throw new BotInvalidError(`launch.${error.message}`);
      throw error;
    }
  }

  /**
   * The session a fork branches from, which must be one of this Bot's own.
   *
   * A Bot is what says which sessions belong to a directory, so "fork that one" is only meaningful
   * about a session it holds. Resolving it here also gives the fork its source's directory, which
   * is not always the Bot's: a session in a worktree forks inside that worktree.
   */
  private resolveOwnSession(bot: BotRecord, ref: BotSessionRef): ResolvedBotSession {
    if (!bot.sessionRefs.some((held) => sessionKey(held) === sessionKey(ref))) {
      throw new BotNotFoundError(`session ${sessionKey(ref)} is not attached to this Bot`);
    }
    const resolved = this.catalog.resolveSession(ref);
    if (!resolved) {
      throw new BotNotFoundError(`session ${sessionKey(ref)} is not in the current catalog`);
    }
    return resolved;
  }

  /**
   * Starts a new Bot's first session, under the next free anchor.
   *
   * The anchor is spent before the launch rather than counted from titles, for the same reason
   * the existing-Bot path reserves first: two launches in one moment must not preview the same
   * name. Kept beside that method rather than in the registry because both halves compose the
   * same `-n` title.
   */
  async launchFirstSession(bot: BotRecord, launch: NormalizedLaunch): Promise<StartedSession> {
    const sessionId = this.newSessionId();
    const anchor = await this.reserveAnchor(bot.botId, `claude:${sessionId}`);
    return this.launchOrExplain(bot, { ...launch, ...this.startingTitle(anchor, launch) }, () => sessionId);
  }

  /**
   * Starts a session on a Bot that already exists, under its next anchor and slot, the slot
   * numbered for the place it will stand: after `after` when the Bot holds that, else at the end.
   *
   * Both are spent BEFORE the launch, in one mutation, so the `-n` title, the stored slot and
   * the stored anchor always agree: reserving first is what keeps two launches in one moment
   * from previewing the same number. A launch that is then refused or fails still spends both,
   * which the slot rule already prices in -- spent identifiers are never reused either way, so
   * a gap is a gap and not a collision.
   *
   * The attach afterwards (`recordStartedSession`) finds both reservations and keeps them, which
   * is why this and that agree without sharing anything but the session id.
   */
  async launchReservedSession(
    botId: string,
    bot: BotRecord,
    launch: NormalizedLaunch,
    after?: BotSessionRef,
  ): Promise<StartedSession> {
    const sessionId = this.newSessionId();
    const ref: BotSessionRef = { source: "claude", sessionId };
    const key = sessionKey(ref);
    const reserved = await this.store.mutate((snapshot) => {
      const index = snapshot.bots.findIndex((one) => one.botId === botId);
      if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
      const current = snapshot.bots[index]!;
      // Numbered where its card will stand, beside `after` for a fork, so its slot paints unlike
      // the cards either side of it. The order itself is written by `recordStartedSession`.
      const backed = ensureSessionSlots(current, placeRefs(current.sessionRefs, [ref], after));
      const anchor = nextAnchor(spentAnchors(snapshot.bots));
      const updated: BotRecord = {
        ...current,
        ...backed,
        sessionAnchors: { ...(current.sessionAnchors ?? {}), [key]: anchor },
      };
      const bots = [...snapshot.bots];
      bots[index] = updated;
      return {
        snapshot: { ...snapshot, revision: snapshot.revision + 1, bots },
        value: { bot: updated, anchor },
      };
    });
    return this.launchSession(
      reserved.bot,
      { ...launch, ...this.startingTitle(reserved.anchor, launch) },
      () => sessionId,
    );
  }

  /** `startingTitle`, with a fork's source read from the catalog. */
  private startingTitle(anchor: string, launch: NormalizedLaunch): { title: string; unnamed?: boolean } {
    return startingTitle(anchor, launch, launch.from ? this.catalog.resolveSession(launch.from) : undefined);
  }

  /**
   * Spends the next free anchor for a session id that does not exist yet, and stores it.
   *
   * The launch that follows composes its title from the returned anchor, and the attach after
   * that finds the stored entry. A launch that never happens still spends its name, for the
   * reason `launchReservedSession` gives.
   */
  async reserveAnchor(botId: string, key: string): Promise<string> {
    return this.store.mutate((snapshot) => {
      const index = snapshot.bots.findIndex((one) => one.botId === botId);
      if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
      const current = snapshot.bots[index]!;
      if (current.sessionAnchors?.[key] !== undefined) {
        return { snapshot, value: current.sessionAnchors[key] };
      }
      const anchor = nextAnchor(spentAnchors(snapshot.bots));
      const updated: BotRecord = {
        ...current,
        sessionAnchors: { ...(current.sessionAnchors ?? {}), [key]: anchor },
      };
      const bots = [...snapshot.bots];
      bots[index] = updated;
      return {
        snapshot: { ...snapshot, revision: snapshot.revision + 1, bots },
        value: anchor,
      };
    });
  }

  /**
   * Attaches a session this registry just started.
   *
   * Deliberately not `attachSessions`, which resolves every reference against the catalog and
   * refuses one it cannot find. That check is right for a reference a caller supplies -- it is the
   * only thing stopping a Bot claiming another directory's session -- and wrong here, because the
   * session was started seconds ago in the Bot's own directory and has not written a transcript
   * yet, so there is nothing for the catalog to have seen. The id is known-good by construction:
   * this method's caller generated it and passed it to `--session-id`.
   *
   * Until the first turn lands the reference sits in `missingSessionRefs`, which is the honest
   * reading of it, and moves to `sessions` on its own when the catalog picks the file up.
   * It stands after `after` when the Bot holds that one, which is where a fork's card belongs.
   */
  async recordStartedSession(botId: string, ref: BotSessionRef, after?: BotSessionRef): Promise<BotRecord> {
    return this.store.mutate((snapshot) => {
      const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
      if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
      const bot = snapshot.bots[index]!;
      if (bot.sessionRefs.some((existing) => sessionKey(existing) === sessionKey(ref))) {
        return { snapshot, value: bot };
      }
      const heldRefs = placeRefs(bot.sessionRefs, [ref], after);
      const updated: BotRecord = { ...bot, sessionRefs: heldRefs, ...ensureSessionSlots(bot, heldRefs) };
      const bots = [...snapshot.bots];
      bots[index] = updated;
      return {
        snapshot: { ...snapshot, revision: snapshot.revision + 1, bots },
        value: updated,
      };
    });
  }
}

/** A launch with the name it starts under decided: `title`, or none at all when `unnamed`. */
type StartingLaunch = NormalizedLaunch & { unnamed?: boolean };

/**
 * The name a Bot session starts under, and whether it starts under one at all.
 *
 * A task typed at launch is the bracket, `Aaron (checkout flow)`, as it always was. With none, a
 * fresh session starts UNNAMED: Claude writes a title of its own from the first prompt only for a
 * session given no name (`newClaudeSessionCommand` has the measurement, terminal and SDK alike),
 * and the title queue then renames it to `Aaron (Claude's title)`, which it can do mid-turn. Until
 * then the anchor is what its pane and its card are called, and the session answers to its
 * directory's name.
 *
 * A fork with none takes its source's task under its own anchor. Claude never titles a fork (it
 * carries its source's title records through a turn on another subject, measured the same day), so
 * a fork started unnamed would only answer to its source's name until the queue caught up, and the
 * queue would land on this same title.
 */
function startingTitle(
  anchor: string,
  launch: NormalizedLaunch,
  source: ResolvedBotSession | undefined,
): { title: string; unnamed?: boolean } {
  if (taskFromText(launch.title, anchor)) return { title: composeAnchoredTitle(anchor, launch.title) };
  if (!launch.from) return { title: anchor, unnamed: true };
  return { title: source && !source.untitled ? anchoredTitle(anchor, source.summary.title).title : anchor };
}

/**
 * The title a session should wear under its anchor, read off the title it wears now.
 *
 * Already in this anchor's shape reads back as its task, and so does a title made under any other
 * pool name: a session that moved to a new name keeps what it was doing, rather than wearing its
 * old name as the task. (A title that is itself a pool name, `Maple`, reads as one and starts
 * bare; rare enough to accept.) Anything else sheds the previous era's trailing suffixes
 * (`(fork 3)`) and becomes the task whole, so Claude's own title and a hand-typed `/rename` both
 * survive as the bracket rather than being thrown away. A task that cannot bracket, or would make
 * the title too long, is dropped and the session starts bare: the anchor is the half that matters.
 *
 * Shared by the title queue, which keeps every session in this shape, and a fork, which starts in
 * it from its source's title. The reading is `titleTask`, which a handover to opencode names its
 * successor by too.
 */
export function anchoredTitle(anchor: string, current: string): { title: string; dropped?: string } {
  const rawTask = titleTask(current, anchor);
  const fits = rawTask && !refuseTaskText(rawTask) && !sessionTitleRefusal(formatBotSessionTitle(anchor, rawTask));
  const task = fits ? rawTask : "";
  return {
    title: formatBotSessionTitle(anchor, task),
    ...(rawTask && !task ? { dropped: rawTask } : {}),
  };
}

/** The `-n` title a Bot session starts under: its allocated anchor, bracketed with its task. */
function composeAnchoredTitle(anchor: string, requested: string): string {
  const task = taskFromText(requested, anchor);
  const taskRefusal = task ? refuseTaskText(task) : null;
  if (taskRefusal) throw new BotInvalidError(`launch.title: ${taskRefusal}`);
  const title = formatBotSessionTitle(anchor, task);
  const refusal = sessionTitleRefusal(title);
  if (refusal) throw new BotInvalidError(`launch.title: ${refusal}`);
  return title;
}
