// The Bot's own record: creating one, renaming and restyling it, naming its Father,
// and forgetting it.
//
// Beside `useBotCommands` rather than inside it, which keeps the sessions on a Bot: forks,
// handovers, attaches, detaches, reorders. Those act on sessions a Bot holds; these rewrite
// the record itself. Both report failures the same way, through the setter handed in, so a
// Father that would not name says so on the session it was about.

import { useCallback, useState } from "react";
import type {
  AddBotCommand,
  BotSessionRef,
  BotView,
} from "@agentdesk/agent-feed-wire";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { BotFeeds, BotMachine } from "@/features/bots/botMachines";
import type { BotCommandError } from "@/features/bots/canvas/BotCanvas";

export function useBotRecordCommands(
  feeds: BotFeeds,
  setBotCommandError: React.Dispatch<React.SetStateAction<BotCommandError | null>>,
) {
  const [botCreatorOpen, setBotCreatorOpen] = useState(false);

  /**
   * Creates a Bot on the machine whose directory it names.
   *
   * The machine is an argument rather than a lookup, because this is the one command with no Bot to
   * resolve from: the directory is on that machine, its sessions are on that machine, and the
   * registry that will own the record is that machine's. The dialog picks it, since the dialog is
   * where the reader picked the folder.
   */
  const createBot = useCallback(async (
    command: Omit<AddBotCommand, "requestId">,
    machine: BotMachine,
  ) => {
    await machine.feed.createBot(command);
    setBotCreatorOpen(false);
  }, []);

  /**
   * Names this session the Bot's Father, or clears it when the ref is null.
   *
   * There is one Father across every machine. The Bot's own sidecar clears its siblings in the
   * same write; a peer's sidecar cannot see that write, so the Fathers other machines name are
   * cleared here once the naming has landed -- after rather than before, so a naming that fails
   * leaves the old Father where it was instead of leaving none.
   *
   * Nothing is set here on success, for `detachBotSession`'s reason: the Bot stream publishes
   * the new record and the home follows it, which is also what happens when the same Bot is
   * edited from another surface. A failure is named against the session because its row and
   * its card are both on screen to say the naming did not happen.
   */
  const setFatherBotSession = useCallback((bot: BotView, ref: BotSessionRef | null) => {
    const label = ref === null
      ? null
      : bot.sessions
        .find((session) => session.source === ref.source && session.sessionId === ref.sessionId)
        ?.title || ref.sessionId;
    const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
    setBotCommandError(null);
    void (async () => {
      let home: SidecarDataSource;
      try {
        home = feeds.forBot(bot.botId);
        await home.updateBot(bot.botId, {
          fatherSession: ref === null ? null : { source: ref.source, sessionId: ref.sessionId },
        });
      } catch (error) {
        setBotCommandError({
          session: ref === null ? null : `${ref.source}:${ref.sessionId}`,
          message: ref === null
            ? `Could not clear the Father of ${bot.name}: ${reason(error)}`
            : `Could not name ${label} the Father of ${bot.name}: ${reason(error)}`,
        });
        return;
      }
      if (ref === null) return;
      const elsewhere = feeds.bots().filter((other) =>
        other.fatherSession !== undefined && feeds.forBot(other.botId) !== home
      );
      const failed = (await Promise.allSettled(elsewhere.map((other) =>
        feeds.forBot(other.botId).updateBot(other.botId, { fatherSession: null })
      ))).flatMap((result, index) =>
        result.status === "rejected" ? [`${elsewhere[index]!.name}: ${reason(result.reason)}`] : []
      );
      if (failed.length > 0) {
        setBotCommandError({
          session: `${ref.source}:${ref.sessionId}`,
          message: `${label} is the Father now, but another machine still names one. ${failed.join("; ")}`,
        });
      }
    })();
  }, [feeds]);

  /**
   * The Bot being renamed, if any. Held as the Bot rather than its fields so the dialog opens
   * with what the record says now; what it submits is the whole restyle, because a reader
   * renaming a Bot is usually fixing its face at the same time.
   */
  const [renamingBot, setRenamingBot] = useState<BotView | null>(null);
  const renameBot = useCallback(async (
    bot: BotView,
    restyle: { name: string; iconUrl?: string; role?: string },
  ) => {
    await feeds.forBot(bot.botId).updateBot(bot.botId, {
      name: restyle.name,
      ...(restyle.iconUrl === undefined ? {} : { iconUrl: restyle.iconUrl }),
      ...(restyle.role === undefined ? {} : { metadata: { role: restyle.role } }),
    });
    setRenamingBot(null);
  }, [feeds]);

  /**
   * Forgets a Bot. Nothing is set here on success: the Bot stream publishes without it and the
   * card leaves on its own. No confirm dialog, for `detachBotSession`'s reason at one remove:
   * the sessions survive and a recreate restores the Bot, so this undoes like a detach does.
   * A failure has no card to land on, so it goes on the canvas band with no session.
   */
  const deleteBot = useCallback((bot: BotView) => {
    setBotCommandError(null);
    void Promise.resolve()
      .then(() => feeds.forBot(bot.botId).deleteBot(bot.botId))
      .catch((error: unknown) => {
        setBotCommandError({
          session: null,
          message: `Could not delete ${bot.name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });
  }, [feeds]);

  return {
    botCreatorOpen,
    setBotCreatorOpen,
    renamingBot,
    setRenamingBot,
    createBot,
    setFatherBotSession,
    renameBot,
    deleteBot,
  };
}
