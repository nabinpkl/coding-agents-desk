// Bringing a session into existence for a Bot, and recording it once it exists.
//
// Split from the registry because the four decisions below are one act with one owner,
// while the registry around it is about what a command is allowed to do. Its methods
// still read `this.store` and `this.catalog`: they are the registry's own, handed over
// at construction so both halves write through the same store.

import type { BotRecord, BotSessionRef, StartedBotSession } from "@agentdesk/agent-feed-wire";
import {
  branchFromTitle,
  prepareWorktree,
  WorktreeError,
} from "@/git/worktree";
import type { BotStore } from "@/bots/botStore";
import type { NormalizedLaunch } from "@/bots/botCommands";
import { sessionKey } from "@/bots/botIdempotency";
import {
  BotConflictError,
  BotLaunchError,
  BotNotFoundError,
  type BotRegistryCatalog,
  type BotSessionLauncher,
  type ResolvedBotSession,
} from "@/bots/botTypes";

export class BotSessionStarter {
  constructor(
    private readonly store: BotStore,
    private readonly catalog: BotRegistryCatalog,
    private readonly launcher: BotSessionLauncher,
    private readonly newSessionId: () => string,
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
    launch: NormalizedLaunch,
  ): Promise<StartedBotSession> {
    try {
      return await this.launchSession(bot, launch);
    } catch (error) {
      if (error instanceof BotLaunchError) throw error;
      throw new BotLaunchError(
        `Bot "${bot.name}" was created, but its session could not be started. `
          + "Resend this request once the cause is fixed, or attach a session to "
          + `${bot.botId} by hand.`,
        { cause: error },
      );
    }
  }

  /**
   * The one path that brings a session into existence, whichever endpoint asked for it.
   *
   * Creating a Bot with its first session and adding a session to an existing Bot are the same
   * act -- start something in this directory -- and they used to be three different mechanisms:
   * this one, a terminal context that created a session as a side effect of attaching a viewer,
   * and a hand-rolled `tmux new-session` for anyone who had neither. All of them made the same
   * four decisions, and only one of them made all four correctly.
   *
   * The four are: which directory it runs in, whether it starts empty or from another session's
   * context, what its first turn is, and which pane it lands in. They are made here, once.
   */
  async launchSession(
    bot: BotRecord,
    launch: NormalizedLaunch,
  ): Promise<StartedBotSession> {
    const checkout = bot.environment.path;
    // A fork runs where its source runs unless it asked for a tree of its own, so a fork of a
    // session already in a worktree stays in that worktree rather than being pulled back into the
    // checkout it branched away from.
    const source = launch.from ? this.resolveOwnSession(bot, launch.from) : undefined;
    const cwd = launch.worktree
      ? (await this.prepare(checkout, launch)).path
      : source?.projectPath ?? checkout;

    const sessionId = this.newSessionId();
    const started = launch.from
      ? await this.launcher.fork({
        cwd,
        sessionId: launch.from.sessionId,
        forkId: sessionId,
        title: launch.title,
        brief: launch.prompt,
      })
      : await this.launcher.start({ cwd, sessionId, title: launch.title, prompt: launch.prompt });
    return { sessionId, title: launch.title, projectPath: cwd, tmuxSession: started.tmuxSession };
  }

  /** The worktree a launch asked for, refused in this Bot's own words when git will not make it. */
  private async prepare(checkout: string, launch: NormalizedLaunch): Promise<{ path: string }> {
    const branch = launch.worktree?.branch ?? branchFromTitle(launch.title);
    try {
      return await prepareWorktree({ checkout, branch });
    } catch (error) {
      if (error instanceof WorktreeError) throw new BotConflictError(error.message);
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
   */
  async recordStartedSession(botId: string, ref: BotSessionRef): Promise<BotRecord> {
    return this.store.mutate((snapshot) => {
      const index = snapshot.bots.findIndex((bot) => bot.botId === botId);
      if (index < 0) throw new BotNotFoundError(`Bot "${botId}" was not found`);
      const bot = snapshot.bots[index]!;
      if (bot.sessionRefs.some((existing) => sessionKey(existing) === sessionKey(ref))) {
        return { snapshot, value: bot };
      }
      const updated: BotRecord = { ...bot, sessionRefs: [...bot.sessionRefs, ref] };
      const bots = [...snapshot.bots];
      bots[index] = updated;
      return {
        snapshot: { ...snapshot, revision: snapshot.revision + 1, bots },
        value: updated,
      };
    });
  }
}
