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
 * inventory, session commands, usage, config and the Desktop park, and inherits the Bots, what
 * is in a Bot's directory, the agent sessions, the terminals, the composers and the transcript
 * from the layers under it. `sidecarRoutes.ts`
 * explains why it is a chain rather than a facade.
 */

import type {
  ActivityEvent,
  ForkSessionCommand,
  LastSessionMessage,
  ParkPlanResponse,
  ParkReport,
  ParkRestoreReport,
  ParkStateResponse,
  ProjectSummary,
  LimitsStreamMessage,
  SessionSummary,
  SidecarConfig,
  SourceId,
  StartedSession,
  SummaryStreamMessage,
  TokenUsage,
  UsageStreamMessage,
} from "@agentdesk/agent-feed-wire";
import type { AgentDataSource } from "@/features/activity-feed/data-source/AgentDataSource";
import { expectEmpty, parse, type SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import { SidecarBots } from "@/features/activity-feed/data-source/layers/SidecarBots";
import { SidecarHub, type HubHandle } from "@/features/activity-feed/data-source/layers/SidecarHub";

export { SidecarError, type SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
export type { TerminalViewer } from "@/features/activity-feed/data-source/sidecarTerminalStream";

function summaryPath(session: SessionAddress): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/summary`;
}

/** The panel's data source when there is a sidecar behind the transport, which is always. */
export class SidecarDataSource extends SidecarBots implements AgentDataSource {

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

  /**
   * The agent messaging hub, over this same transport.
   *
   * A getter rather than a field, because the hub is one consumer of the transport rather than
   * part of the chain's state: nothing here is subscribed, nothing is cached, and the inbox
   * re-reads on its own schedule.
   */
  hub(): HubHandle {
    return new SidecarHub(this.transport);
  }

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
   *
   * Archived sessions are split off HERE, the one place every inventory reader goes through, so
   * no list, picker or restore can show one by forgetting to filter: `sessions` never holds an
   * archived row, and only a caller that offers them back reads `archived`.
   */
  subscribeInventory(
    projectPaths: readonly string[],
    handlers: {
      onProjects: (projects: ProjectSummary[]) => void;
      onSessions: (projectPath: string, sessions: SessionSummary[], archived: SessionSummary[]) => void;
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
            handlers.onSessions(
              message.projectPath,
              message.sessions.filter((session) => session.archivedAt === undefined),
              message.sessions.filter((session) => session.archivedAt !== undefined),
            );
          }
        },
        onError: (reason) => onError?.(reason),
      },
    );
  }



  /**
   * Renames one session, whichever source owns it, and answers with the name it now has.
   *
   * Two sources carry a title this panel can write. A Claude session carries two names -- the
   * transcript title every row here shows, and the registry address `ListAgents` prints and
   * cross-session messaging delivers to -- and this moves both, because the sidecar renames by
   * running Claude's own `/rename` in the session rather than by writing its transcript.
   *
   * That is also why it can fail for reasons that are not about the name: a session with no
   * running process has nothing to ask, and one with unsent text in its composer must not be
   * typed into. Both come back as a conflict carrying the reason, which the dialog shows. Neither
   * reaches an opencode session, whose one name is a label its serve holds and can write whether
   * or not anything is running.
   *
   * Nothing else has to happen for a successful rename to land: the session writes its own records
   * (or its serve does) and the inventory stream pushes the new title on its next read.
   */
  async renameSession(source: SourceId, sessionId: string, title: string): Promise<string> {
    if (source === "opencode") return this.renameOpencodeSession(sessionId, title);
    // A row that offers Rename is gated on this, so reaching here is a gate that drifted rather
    // than a reader's mistake. Said rather than swallowed.
    if (source !== "claude") throw new Error(`a ${source} session has no title to rename`);
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
   * Files a session away, or brings it back, on the machine this data source talks to.
   *
   * Archiving is refused while the session is running, and the refusal comes back as a conflict
   * carrying the reason. Nothing else has to happen when it lands: the inventory and Bot streams
   * republish without the session.
   */
  async setSessionArchived(session: SessionAddress, archived: boolean): Promise<void> {
    parse<unknown>(
      await this.transport.request(
        "POST",
        `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/${archived ? "archive" : "unarchive"}`,
      ),
    );
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
  async lastMessage(
    sessionId: string,
    { said = false, before }: { said?: boolean; before?: number } = {},
  ): Promise<LastSessionMessage> {
    const query = [said ? "said=1" : null, before === undefined ? null : `before=${before}`]
      .filter((part) => part !== null)
      .join("&");
    return parse<LastSessionMessage>(
      await this.transport.request(
        "GET",
        `/api/sessions/claude/${encodeURIComponent(sessionId)}/last-message${query ? `?${query}` : ""}`,
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
