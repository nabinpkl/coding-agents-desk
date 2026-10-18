/**
 * The Bot roster: snapshots, creation, membership, arrangement, and forgetting.
 *
 * One more layer in the chain `sidecarRoutes.ts` describes, holding every call the panel makes
 * ABOUT a Bot -- its record, its sessions, its place on the canvas -- rather than into its
 * directory (that is `SidecarBotDirectory`) or about a session's own transcript. The stream
 * carries every change back, so nothing here predicts: each method asks and answers.
 */

import type {
  AddBotCommand,
  AddBotSessionsCommand,
  BotSessionPlaced,
  BotSessionRef,
  BotSessionsAdded,
  BotSnapshot,
  BotView,
  DetachBotSessionsCommand,
  ReorderBotSessionsCommand,
  SetBotCanvasCommand,
  UpdateBotCommand,
  WorkspaceBrowseListing,
  WorkspaceFolderCreated,
} from "@agentdesk/agent-feed-wire";
import { parse } from "@/features/activity-feed/data-source/sidecarRoutes";
import { SidecarBotDirectory } from "@/features/activity-feed/data-source/layers/SidecarBotDirectory";

export class SidecarBots extends SidecarBotDirectory {
  subscribeBots(onSnapshot: (snapshot: BotSnapshot) => void, onError?: (reason: string) => void): () => void {
    return this.transport.subscribe("/api/bots/stream", {
      onMessage: (payload) => {
        try {
          const message = JSON.parse(payload) as Partial<BotSnapshot> & {
            error?: { message?: string };
          };
          if (message.error) {
            onError?.(message.error.message ?? "Bot stream failed");
            return;
          }
          if (message.version !== 2 || !Number.isSafeInteger(message.revision) || !Array.isArray(message.bots)) {
            onError?.("Bot stream returned an invalid snapshot");
            return;
          }
          onSnapshot(message as BotSnapshot);
        } catch {
          onError?.("Bot stream returned malformed JSON");
        }
      },
      onError: (reason) => onError?.(reason),
    });
  }

  /**
   * The directories inside one directory, for choosing a Bot's own.
   *
   * Here rather than only on `WorkspaceIdeClient` because a Bot can be created on any machine the
   * canvas reads, and the picker has to list the directories of the machine the reader chose. The
   * route is the IDE's -- one server-side folder picker, since nothing in the web platform hands a
   * page an absolute path -- and it is confined to home by the sidecar.
   *
   * A null path means "start where the sidecar starts", which is that machine's home directory. The
   * panel cannot know what that is, and guessing it here would be a second place holding the answer.
   */
  async browseDirectories(path: string | null): Promise<WorkspaceBrowseListing> {
    const query = path === null ? "" : `?path=${encodeURIComponent(path)}`;
    return parse<WorkspaceBrowseListing>(await this.transport.request("GET", `/api/workspaces/browse${query}`));
  }

  /**
   * Make a folder on this machine, for the same picker `browseDirectories` serves.
   *
   * On this layer rather than only on `WorkspaceIdeClient` because that client belongs to the IDE
   * and a Bot can be created on any machine the canvas reads: the folder a reader makes while
   * naming a Bot has to land on the machine they picked, which is the whole reason this browse is
   * here rather than there.
   */
  async createDirectory(path: string, name: string): Promise<WorkspaceBrowseListing> {
    const created = parse<WorkspaceFolderCreated>(
      await this.transport.request("POST", "/api/workspaces/folders", { body: { path, name } }),
    );
    return created.listing;
  }

  async createBot(command: Omit<AddBotCommand, "requestId">): Promise<BotView> {
    return parse<BotView>(
      await this.transport.request("POST", "/api/bots", {
        body: { ...command, requestId: crypto.randomUUID() },
      }),
    );
  }

  async addBotSessions(botId: string, command: Omit<AddBotSessionsCommand, "requestId">): Promise<BotSessionsAdded> {
    return parse<BotSessionsAdded>(
      await this.transport.request("POST", `/api/bots/${encodeURIComponent(botId)}/sessions`, {
        body: { ...command, requestId: crypto.randomUUID() },
      }),
    );
  }

  /**
   * Puts a session on the Bot of the directory it works in, which the sidecar makes first when
   * there is none. Asked of the session's own machine, because that is where its directory is.
   */
  async placeSessionOnBot(sessionRef: BotSessionRef): Promise<BotSessionPlaced> {
    return parse<BotSessionPlaced>(
      await this.transport.request("POST", "/api/bots/placements", {
        body: { sessionRef, requestId: crypto.randomUUID() },
      }),
    );
  }

  /**
   * Drops references from a Bot's projection. A DELETE on the collection the POST above adds
   * to: the verb is what keeps a body naming sessionRefs from reading as an attach.
   */
  async detachBotSessions(botId: string, command: Omit<DetachBotSessionsCommand, "requestId">): Promise<BotView> {
    return parse<BotView>(
      await this.transport.request("DELETE", `/api/bots/${encodeURIComponent(botId)}/sessions`, {
        body: { ...command, requestId: crypto.randomUUID() },
      }),
    );
  }

  /**
   * Renames a Bot, restyles it, or names its Father. A PATCH, because each field left out is
   * left as it is. The stream carries the new record back, so nothing here is updated on
   * success -- the rows move on their own, which is also what happens when the same Bot is
   * edited from another surface.
   */
  async updateBot(botId: string, command: UpdateBotCommand): Promise<BotView> {
    return parse<BotView>(
      await this.transport.request("PATCH", `/api/bots/${encodeURIComponent(botId)}`, { body: command }),
    );
  }

  /**
   * Forgets a Bot. The sessions survive -- panes keep running, transcripts stay attachable --
   * so there is no confirm dialog on this side: it undoes with a recreate the way a detach
   * undoes with a reattach. A second call answers 404, which reads as already gone.
   */
  async deleteBot(botId: string): Promise<{ deleted: string }> {
    return parse<{ deleted: string }>(
      await this.transport.request("DELETE", `/api/bots/${encodeURIComponent(botId)}`, { body: {} }),
    );
  }
  /**
   * Stands a Bot's sessions in a new order, and answers with the Bot holding it. A PUT, because
   * it names the Bot's whole order and is refused unless that is exactly what the Bot holds --
   * a complete replacement. Its own path rather than the attach one, where a body naming
   * sessionRefs ADDS them; stating the whole order is what makes a stale roster detectable.
   */
  async reorderBotSessions(botId: string, command: Omit<ReorderBotSessionsCommand, "requestId">): Promise<BotView> {
    return parse<BotView>(
      await this.transport.request("PUT", `/api/bots/${encodeURIComponent(botId)}/sessions/order`, {
        body: { ...command, requestId: crypto.randomUUID() },
      }),
    );
  }

  /**
   * Puts a Bot, or some of its sessions, on or off the canvas. A PATCH, because each field left
   * out is left as it is. Stored on the Bot's record, so every surface reading this machine sees
   * the same canvas; the stream carries the change back.
   */
  async setBotCanvas(botId: string, command: SetBotCanvasCommand): Promise<BotView> {
    return parse<BotView>(
      await this.transport.request("PATCH", `/api/bots/${encodeURIComponent(botId)}/canvas`, { body: command }),
    );
  }
}
