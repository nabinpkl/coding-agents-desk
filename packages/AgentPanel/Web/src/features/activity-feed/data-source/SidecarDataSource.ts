/**
 * The panel's view of the agent-feed sidecar: its routes, called directly.
 *
 * What this replaces is worth stating, because the size difference is the point. The bridge data
 * source was ~1,800 lines, and almost none of it was about the feed. It was request/response
 * correlation, per-type subscription bookkeeping, buffered page reassembly, and timeout handling
 * -- machinery the typed message protocol needed because it had no notion of a request that gets
 * an answer. HTTP has one, so it is gone.
 *
 * What is left is a call per sidecar route, plus one thing that genuinely is this layer's job:
 * turning the composite `/timeline` stream into the handler callbacks the viewer already speaks.
 * That last part now lives one layer down, in `SidecarTranscript.ts`.
 *
 * The class is one API split across files by what its methods are about: this file holds the
 * inventory, the Bots, session commands, usage, config and the Desktop park, and inherits the
 * agent sessions, the terminals, the composers and the transcript from the layers under it. `sidecarRoutes.ts`
 * explains why it is a chain rather than a facade.
 */

import type {
  ActivityEvent,
  AddBotCommand,
  AddBotSessionsCommand,
  BotGitDiff,
  BotGitStatus,
  BotSessionsAdded,
  BotSnapshot,
  BotView,
  DetachBotSessionsCommand,
  ForkSessionCommand,
  LastSessionMessage,
  ParkPlanResponse,
  ParkReport,
  ParkRestoreReport,
  ParkStateResponse,
  ProjectSummary,
  ReorderBotSessionsCommand,
  LimitsStreamMessage,
  SessionSummary,
  SetBotCanvasCommand,
  SidecarConfig,
  StartedSession,
  SummaryStreamMessage,
  TokenUsage,
  UsageStreamMessage,
  WorkspaceBrowseListing,
} from "@agentdesk/agent-feed-wire";
import type { AgentDataSource } from "@/features/activity-feed/data-source/AgentDataSource";
import { expectEmpty, parse, type SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import { SidecarAgentSessions } from "@/features/activity-feed/data-source/SidecarAgentSessions";

export { SidecarError, type SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
export type { TerminalViewer } from "@/features/activity-feed/data-source/sidecarTerminalStream";

function summaryPath(session: SessionAddress): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/summary`;
}

/** The panel's data source when there is a sidecar behind the transport, which is always. */
export class SidecarDataSource extends SidecarAgentSessions implements AgentDataSource {

  /**
   * The one config read, shared. Several features ask "what does this sidecar
   * offer" at mount, and each asking separately turned a startup burst into
   * real failures: the host relay admits a small fixed number of concurrent
   * requests, a config read that lost that race rejected, and the hook that
   * asked hid its feature for the life of the page ("no yabai" on a machine
   * with yabai). One request serves every asker, and a loss is retried after
   * the mount storm has passed instead of being taken as an answer.
   */
  private configRead: Promise<SidecarConfig> | null = null;

  // ---------------------------------------------------------------------
  // Inventory
  // ---------------------------------------------------------------------

  /**
   * Follows the project list, and the session list of every project in `projectPaths`.
   * Returns unsubscribe.
   *
   * One subscription for the whole sidebar, not one per project. The host relay admits
   * a bounded number of concurrent subscriptions per surface, and the per-project
   * streams spent that budget on connections that all carried the same catalog: a
   * fourth expanded project used to exhaust it, and the refusal landed on whichever
   * request asked next.
   *
   * Changing which projects are open means resubscribing, which is why the caller
   * passes the whole set rather than adding to it: the sidecar reads the set when the
   * stream opens, and one stream reopening costs one slot, never two.
   */
  subscribeInventory(
    projectPaths: readonly string[],
    handlers: {
      onProjects: (projects: ProjectSummary[]) => void;
      onSessions: (projectPath: string, sessions: SessionSummary[]) => void;
    },
    onError?: (reason: string) => void,
  ): () => void {
    const query = projectPaths
      .map((path) => `projectPath=${encodeURIComponent(path)}`)
      .join("&");
    return this.transport.subscribe(
      query ? `/api/inventory/stream?${query}` : "/api/inventory/stream",
      {
        onMessage: (payload) => {
          const message = JSON.parse(payload) as {
            projects?: ProjectSummary[];
            projectPath?: string;
            sessions?: SessionSummary[];
          };
          if (message.projects) handlers.onProjects(message.projects);
          else if (message.projectPath && message.sessions) {
            handlers.onSessions(message.projectPath, message.sessions);
          }
        },
        onError: (reason) => onError?.(reason),
      },
    );
  }

  // ---------------------------------------------------------------------
  // Curated Bots
  // ---------------------------------------------------------------------

  subscribeBots(
    onSnapshot: (snapshot: BotSnapshot) => void,
    onError?: (reason: string) => void,
  ): () => void {
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
    return parse<WorkspaceBrowseListing>(
      await this.transport.request("GET", `/api/workspace/browse${query}`),
    );
  }

  async createBot(command: Omit<AddBotCommand, "requestId">): Promise<BotView> {
    return parse<BotView>(
      await this.transport.request("POST", "/api/bots", {
        body: { ...command, requestId: crypto.randomUUID() },
      }),
    );
  }

  async addBotSessions(
    botId: string,
    command: Omit<AddBotSessionsCommand, "requestId">,
  ): Promise<BotSessionsAdded> {
    return parse<BotSessionsAdded>(
      await this.transport.request(
        "POST",
        `/api/bots/${encodeURIComponent(botId)}/sessions`,
        { body: { ...command, requestId: crypto.randomUUID() } },
      ),
    );
  }

  /** A POST, not a DELETE: the host relay admits GET and POST only. */
  async detachBotSessions(
    botId: string,
    command: Omit<DetachBotSessionsCommand, "requestId">,
  ): Promise<BotView> {
    return parse<BotView>(
      await this.transport.request(
        "POST",
        `/api/bots/${encodeURIComponent(botId)}/sessions/detach`,
        { body: { ...command, requestId: crypto.randomUUID() } },
      ),
    );
  }

  /**
   * Stands a Bot's sessions in a new order, and answers with the Bot holding it. Its own path
   * rather than the attach one, where a body naming sessionRefs ADDS them; it states the Bot's
   * whole order and is refused unless that is exactly what the Bot holds, so a panel working from
   * a roster that has moved is told rather than silently rewriting it.
   */
  async reorderBotSessions(
    botId: string,
    command: Omit<ReorderBotSessionsCommand, "requestId">,
  ): Promise<BotView> {
    return parse<BotView>(
      await this.transport.request(
        "POST",
        `/api/bots/${encodeURIComponent(botId)}/sessions/order`,
        { body: { ...command, requestId: crypto.randomUUID() } },
      ),
    );
  }

  /**
   * Puts a Bot, or some of its sessions, on or off the canvas. Stored on the Bot's record, so every
   * surface reading this machine sees the same canvas; the stream carries the change back.
   */
  async setBotCanvas(botId: string, command: SetBotCanvasCommand): Promise<BotView> {
    return parse<BotView>(
      await this.transport.request(
        "POST",
        `/api/bots/${encodeURIComponent(botId)}/canvas`,
        { body: command },
      ),
    );
  }

  /** What is uncommitted in the Bot's directory, read fresh from git on this machine. */
  async botGitStatus(botId: string): Promise<BotGitStatus> {
    return parse<BotGitStatus>(
      await this.transport.request("GET", `/api/bots/${encodeURIComponent(botId)}/git`),
    );
  }

  /** One path's uncommitted change in the Bot's directory, against `HEAD`. */
  async botGitDiff(botId: string, path: string): Promise<BotGitDiff> {
    const query = new URLSearchParams({ path });
    return parse<BotGitDiff>(
      await this.transport.request("GET", `/api/bots/${encodeURIComponent(botId)}/git/diff?${query}`),
    );
  }

  /**
   * Renames one Claude session, and answers with the name it now has.
   *
   * A session carries two names -- the transcript title every row here shows, and the registry
   * address `ListAgents` prints and cross-session messaging delivers to -- and this moves both,
   * because the sidecar renames by running Claude's own `/rename` in the session rather than by
   * writing its transcript.
   *
   * That is also why it can fail for reasons that are not about the name: a session with no
   * running process has nothing to ask, and one with unsent text in its composer must not be
   * typed into. Both come back as a conflict carrying the reason, which the dialog shows.
   *
   * Nothing else has to happen for a successful rename to land: the session writes its own
   * records and the inventory stream pushes the new title on its next read.
   */
  async renameSession(sessionId: string, title: string): Promise<string> {
    const answer = parse<{ title?: unknown }>(
      await this.transport.request(
        "POST",
        `/api/sessions/claude/${encodeURIComponent(sessionId)}/title`,
        { body: { title } },
      ),
    );
    if (typeof answer.title !== "string") throw new Error("Rename returned no title");
    return answer.title;
  }

  /**
   * Branches one Claude session into a new one, and answers with the session that now exists.
   *
   * Addressed by the session rather than by a Bot, which is what lets a reader fork from the
   * transcript they are reading: the transcript view has no Bot to hang the request on, and a
   * session nobody had curated onto one could not be forked at all.
   *
   * `command.from` names a message to start just BEFORE, by the event id the panel already holds
   * for that row. The sidecar resolves it against the transcript and drives Claude's own rewind in
   * the fork's pane, because nothing else can move a conversation's point and the transcript has
   * exactly one writer.
   *
   * A rewind that did not happen comes back on `rewindFailed` rather than as an error. The fork
   * EXISTS in that case, holding the whole conversation instead of the slice that was asked for,
   * and a caller told only "it failed" would not know there was a session to deal with.
   */
  async forkSession(sessionId: string, command: ForkSessionCommand): Promise<StartedSession> {
    return parse<StartedSession>(
      await this.transport.request(
        "POST",
        `/api/sessions/claude/${encodeURIComponent(sessionId)}/fork`,
        { body: command },
      ),
    );
  }

  /**
   * The newest message a person wrote in this session, and the row it is.
   *
   * What a fork asked for from the session's own ⋮ starts before. The reader has picked no row --
   * that is the point of it, since the row menu that offers a fork is ON the row, so the longer
   * the transcript the further away the affordance was -- and this is where "the last thing I
   * said" gets turned into one.
   *
   * Answered by the sidecar rather than found here. Which lines are people talking is a rule with
   * one home (`humanTurns.ts`, and the scar in its comment), and the surfaces that ask hold no
   * transcript to look through: a closed card and a roster row have streamed nothing.
   *
   * Rejects with the sidecar's own reason when there is no such message, which is a real state --
   * a session whose first turn has not landed yet -- and not an error to swallow.
   */
  async lastMessage(sessionId: string): Promise<LastSessionMessage> {
    return parse<LastSessionMessage>(
      await this.transport.request(
        "GET",
        `/api/sessions/claude/${encodeURIComponent(sessionId)}/last-message`,
      ),
    );
  }

  /**
   * The first message a person wrote after this session's newest compaction.
   *
   * The point a fork can be moved to that drops everything done since the context was summarised,
   * and it is a message rather than the compaction itself because the compaction is not a row the
   * rewind picker offers -- Claude filters both records it writes out of that list. Same shape as
   * `lastMessage` because it is the same kind of answer, and the fork dialog takes either.
   *
   * Rejects with the sidecar's reason when there is no such point: a session that was never
   * compacted, or one nothing has been said to since, where an ordinary fork already starts there.
   */
  async lastCompaction(sessionId: string): Promise<LastSessionMessage> {
    return parse<LastSessionMessage>(
      await this.transport.request(
        "GET",
        `/api/sessions/claude/${encodeURIComponent(sessionId)}/last-compaction`,
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------

  /**
   * Digests one turn -- the window from the last user message to now -- and streams the work.
   *
   * Takes a `SessionAddress` rather than a `SessionReference` for the same reason the commands
   * do: the digest is always taken over the `nice` view, so a mode passed here could only be
   * wrong. Returns unsubscribe, and the CALLER MUST CALL IT once a `result` or `error` arrives.
   * This stream is finite and expensive; a subscription left open on an ended stream is one an
   * `EventSource` reopens, which starts another digest.
   */
  summarizeTurn(
    session: SessionAddress,
    handlers: {
      onMessage: (message: SummaryStreamMessage) => void;
      onError: (reason: string) => void;
    },
  ): () => void {
    return this.transport.subscribe(summaryPath(session), {
      onMessage: (payload) => handlers.onMessage(JSON.parse(payload) as SummaryStreamMessage),
      onError: (reason) => handlers.onError(reason),
    });
  }

  /**
   * Follows this machine's per-day token usage. Returns unsubscribe.
   *
   * Not addressed to a session: usage is a fact about the machine, read from vendor files that no
   * open thread necessarily corresponds to. The stream is finite -- a report from cache, then a
   * report from the sweep if anything moved -- and the CALLER MUST UNSUBSCRIBE when it ends,
   * because an `EventSource` reopens a stream the server closed.
   */
  subscribeUsage(handlers: {
    onMessage: (message: UsageStreamMessage) => void;
    onError: (reason: string) => void;
  }): () => void {
    return this.transport.subscribe("/api/usage", {
      onMessage: (payload) => handlers.onMessage(JSON.parse(payload) as UsageStreamMessage),
      onError: (reason) => handlers.onError(reason),
    });
  }

  /**
   * Follows this machine's live rate-limit meters. Returns unsubscribe.
   *
   * Endless, unlike `subscribeUsage` above, so there is nothing for the caller to detect the end
   * of -- it carries a report on open and another whenever the meters move, until the reader goes
   * away. Pushed rather than polled because the sidecar is already told: the proxy observer hands
   * it the rate-limit headers as each Anthropic response comes back.
   */
  subscribeLimits(handlers: {
    onMessage: (message: LimitsStreamMessage) => void;
    onError: (reason: string) => void;
  }): () => void {
    return this.transport.subscribe("/api/limits", {
      onMessage: (payload) => handlers.onMessage(JSON.parse(payload) as LimitsStreamMessage),
      onError: (reason) => handlers.onError(reason),
    });
  }

  /** The sidecar's process-global facts, read once so the panel knows what to offer. */
  async fetchConfig(): Promise<SidecarConfig> {
    this.configRead ??= this.readConfigPatiently();
    try {
      return await this.configRead;
    } catch (error) {
      // The next caller starts over rather than inheriting a dead promise.
      this.configRead = null;
      throw error;
    }
  }

  private async readConfigPatiently(): Promise<SidecarConfig> {
    const delaysMs = [0, 1_000, 4_000];
    let lastFailure: unknown;
    for (const delayMs of delaysMs) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        return parse<SidecarConfig>(await this.transport.request("GET", "/api/config"));
      } catch (error) {
        lastFailure = error;
      }
    }
    throw lastFailure;
  }


  // ---------------------------------------------------------------------
  // Desktop park
  // ---------------------------------------------------------------------

  /** What the Desktops currently hold. Read-only. */
  async fetchParkState(): Promise<ParkStateResponse> {
    return parse<ParkStateResponse>(await this.transport.request("GET", "/api/park/state"));
  }

  /** Where a park would put everything, and whether that plan holds up. Read-only. */
  async fetchParkPlan(app?: string): Promise<ParkPlanResponse> {
    const query = app && app.trim() !== "" ? `?app=${encodeURIComponent(app.trim())}` : "";
    return parse<ParkPlanResponse>(await this.transport.request("GET", `/api/park/plan${query}`));
  }

  /**
   * Gather every candidate onto one Desktop and lay the ladder.
   *
   * `confirm` is sent explicitly rather than implied by calling this, because the
   * sidecar refuses without it: this rearranges someone's whole workspace and a
   * request that arrives by accident must do nothing.
   */
  async park(options: { app?: string } = {}): Promise<ParkReport> {
    return parse<ParkReport>(
      await this.transport.request("POST", "/api/park", {
        body: { confirm: true, ...(options.app ? { app: options.app } : {}) },
      }),
    );
  }

  async restorePark(): Promise<ParkRestoreReport> {
    return parse<ParkRestoreReport>(
      await this.transport.request("POST", "/api/park/restore", { body: { confirm: true } }),
    );
  }
}

export type { ActivityEvent, ProjectSummary, SessionSummary, TokenUsage };
