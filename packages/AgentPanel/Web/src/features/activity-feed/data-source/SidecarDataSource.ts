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
 */

import type {
  AddBotCommand,
  AddBotSessionsCommand,
  BotSessionsAdded,
  ActivityEvent,
  ComposerImageDrop,
  ComposerKeyPress,
  RailKey,
  RailModifiers,
  AgentCommandReceipt,
  AgentSessionDescriptor,
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentTerminalHistory,
  AgentTerminalStreamEnvelope,
  AgentTerminalStreamMessage,
  AgentTerminalViewport,
  AgentUiEvent,
  BackgroundTaskSnapshot,
  BotSnapshot,
  BotView,
  CliInputReceipt,
  CliInputStatus,
  TmuxComposerState,
  DetachBotSessionsCommand,
  EventsPage as WireEventsPage,
  ParkPlanResponse,
  ParkReport,
  ParkRestoreReport,
  ParkStateResponse,
  ProjectSummary,
  SessionSummary,
  SidecarConfig,
  SummaryStreamMessage,
  TaskOutputMessage,
  TmuxSessionSummary,
  TimelineMessage,
  TokenUsage,
  UsageStreamMessage,
  WindowComposerEnvelope,
  WindowComposerStatus,
  WindowQuestionAction,
  WindowQuestionStatus,
} from "@agentdesk/agent-feed-wire";
import type {
  AgentDataSource,
  AgentSessionState,
  EventsPage,
  SessionEventsHandlers,
  SessionReference,
} from "./AgentDataSource";
import type { AgentHttpTransport } from "../transport/AgentHttpTransport";

/** Thrown when the sidecar answered, but with an error rather than the thing asked for. */
export class SidecarError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "SidecarError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Parses a response body, or throws.
 *
 * A non-2xx carries a `{ error: { code, message } }` body the panel can act on -- an unsupported
 * mode reads differently from a session that is gone -- so the code is preserved rather than
 * flattened into a generic failure.
 */
function parse<T>(response: { status: number; body: string }): T {
  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    throw new SidecarError("malformed-response", "sidecar response was not JSON", response.status);
  }
  if (response.status < 200 || response.status >= 300) {
    const error = (payload as { error?: { code?: string; message?: string } }).error;
    throw new SidecarError(
      error?.code ?? "sidecar-error",
      error?.message ?? `sidecar answered ${response.status}`,
      response.status,
    );
  }
  return payload as T;
}

function expectEmpty(response: { status: number; body: string }): void {
  if (response.status >= 200 && response.status < 300) return;
  parse<never>(response);
}

function timelinePath(session: SessionReference): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/timeline?mode=${session.mode}`;
}

function cliInputPath(session: SessionAddress): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/input`;
}

/**
 * The other way of typing at the same session, so it sits at the same address.
 *
 * Claude-only on the sidecar, which refuses any other source from the route pattern; the source is
 * still interpolated rather than hardcoded so a mistaken call fails as a 404 instead of quietly
 * addressing the wrong session's pane.
 */
function tmuxComposerPath(
  session: SessionAddress,
  action: "" | "/submit" | "/accept" | "/image" | "/key" | "/stream" = "",
): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/composer${action}`;
}

/**
 * A blob's bytes as base64, without holding a second copy of them as a JS string of characters.
 *
 * `FileReader` rather than `btoa` over a byte string: the argument to `btoa` has to be built one
 * character at a time, which for a few megabytes of screenshot is a string longer than the image
 * and a loop the main thread notices. The reader hands back a `data:` URL and the base64 is
 * everything after its comma.
 */
function base64FromBlob(image: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the image"));
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      if (comma < 0) {
        reject(new Error("could not read the image"));
        return;
      }
      resolve(url.slice(comma + 1));
    };
    reader.readAsDataURL(image);
  });
}

function summaryPath(session: SessionAddress): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/summary`;
}

function tasksPath(session: SessionReference): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/tasks`;
}

function taskOutputPath(session: SessionReference, taskId: string): string {
  return `${tasksPath(session)}/${encodeURIComponent(taskId)}/output`;
}

function eventsPath(session: SessionReference, offset: number, limit: number): string {
  return `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/events?offset=${offset}&limit=${limit}&mode=${session.mode}`;
}

/**
 * Enough of a session to name it in a URL.
 *
 * Commands take this rather than a full `SessionReference` because a command is not read in a
 * mode: aborting a run or answering a prompt means the same thing whichever view of the
 * transcript is on screen, and requiring the mode would invite a caller to invent one.
 */
export interface SessionAddress {
  source: string;
  sessionId: string;
}

interface TerminalViewer {
  onMessage: (message: AgentTerminalStreamMessage) => void;
  onError?: (reason: string) => void;
}

/** The panel's data source when there is a sidecar behind the transport, which is always. */
/**
 * How long a terminal may sit on "opening" before the viewer is told the stream never carried.
 *
 * Generous: this is the connect time of an SSE stream over a tailnet that may be relaying through
 * DERP, not a request budget. Short enough that a starved stream is a visible failure rather than
 * a terminal nobody can explain.
 */
const TERMINAL_STREAM_OPEN_TIMEOUT_MS = 8_000;

export class SidecarDataSource implements AgentDataSource {
  constructor(private readonly transport: AgentHttpTransport) {}

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
   * Every terminal viewer on one connection, dispatched by id.
   *
   * A stream each was affordable while one terminal was open at a time. It is not for a wall of
   * them: this origin negotiates HTTP/1.1, where a browser keeps about six connections and an
   * EventSource holds one for as long as it lives, so the seventh terminal would wait forever and
   * take the panel's ordinary requests down with it. Opened on the first viewer, closed after the
   * last, so a panel with no terminal open holds no connection.
   */
  private readonly terminalViewers = new Map<string, Set<TerminalViewer>>();
  private terminalStream: (() => void) | null = null;
  /**
   * Resolves when the shared stream is actually carrying, which the screen replay has to wait for.
   *
   * Nothing replays a message published while no observer was attached, and the stream connects a
   * round trip after it is asked to. Measured: a replay requested before the connection was up was
   * delivered to nobody, and the terminal sat blank and silent -- tmux sends nothing to a client
   * that is already attached and has not changed, so the lost screen never came back on its own.
   */
  private terminalStreamOpen: Promise<void> | null = null;

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

  // ---------------------------------------------------------------------
  // Claude Desktop composer and AskUserQuestion panel
  // ---------------------------------------------------------------------

  /**
   * One session's composer and question state, as they change.
   *
   * One stream carrying both, because the sidecar reads them in one pass: the question mirror rides
   * the composer's poll, and asking for them separately would double the Accessibility traffic for a
   * window that is walked once either way.
   *
   * Reaching the sidecar rather than the host lane is the point of ADR-0110. The capability bound did
   * not go away -- the sidecar resolves the window and the standalone helper is the only thing
   * holding `AXUIElement` -- but a change to a poll interval or a failure sentence stopped costing a
   * host build and a re-attach of every surface.
   */
  subscribeWindowComposer(
    session: { source: string; sessionId: string },
    handlers: {
      onComposer?: (status: WindowComposerStatus) => void;
      onQuestion?: (status: WindowQuestionStatus) => void;
      onError?: (reason: string) => void;
    },
  ): () => void {
    return this.transport.subscribe(
      `/api/window/composer/stream?source=${encodeURIComponent(session.source)}`
        + `&sessionId=${encodeURIComponent(session.sessionId)}`,
      {
        onMessage: (payload) => {
          try {
            const envelope = JSON.parse(payload) as WindowComposerEnvelope & {
              error?: { message?: string };
            };
            if (envelope.error) {
              handlers.onError?.(envelope.error.message ?? "Composer stream failed");
              return;
            }
            if (envelope.composer) handlers.onComposer?.(envelope.composer);
            if (envelope.question) handlers.onQuestion?.(envelope.question);
          } catch {
            handlers.onError?.("Composer stream returned malformed JSON");
          }
        },
        onError: (reason) => handlers.onError?.(reason),
      },
    );
  }

  /** Fills the composer without committing it. Returns what the field reads back. */
  async syncWindowComposer(
    session: { source: string; sessionId: string },
    text: string,
  ): Promise<string> {
    return parse<{ text: string }>(
      await this.transport.request("POST", "/api/window/composer/sync", {
        body: { ...session, text },
      }),
    ).text;
  }

  /** Fills the composer and presses Return. This one deliberately fronts the Claude window. */
  async submitWindowComposer(
    session: { source: string; sessionId: string },
    text: string,
  ): Promise<string> {
    return parse<{ text: string }>(
      await this.transport.request("POST", "/api/window/composer/submit", {
        body: { ...session, text },
      }),
    ).text;
  }

  /**
   * Reads the composer, moving the window here if that is what it takes.
   *
   * A POST rather than a GET despite reading nothing but the composer: it can move a window between
   * Desktops, which is a side effect the user asked for explicitly and not something a retry or a
   * prefetch should be free to do.
   */
  async readWindowComposer(session: { source: string; sessionId: string }): Promise<string> {
    return parse<{ text: string }>(
      await this.transport.request("POST", "/api/window/composer/read", { body: session }),
    ).text;
  }

  /** One AskUserQuestion interaction, answered with the panel's post-action state. */
  async actOnWindowQuestion(
    sessionId: string,
    action: WindowQuestionAction,
  ): Promise<WindowQuestionStatus> {
    return parse<WindowQuestionStatus>(
      await this.transport.request("POST", "/api/window/question/action", {
        body: { sessionId, ...action },
      }),
    );
  }

  // ---------------------------------------------------------------------
  // Agent terminal
  // ---------------------------------------------------------------------

  async openTerminal(
    context: AgentTerminalContext,
    columns: number,
    rows: number,
  ): Promise<AgentTerminalDescriptor> {
    return parse<AgentTerminalDescriptor>(
      await this.transport.request("POST", "/api/terminals", {
        body: { context, columns, rows },
      }),
    );
  }

  /** What a terminal can be pointed at besides an agent session; empty when tmux holds nothing. */
  async listTmuxSessions(): Promise<TmuxSessionSummary[]> {
    const { sessions } = parse<{ sessions: TmuxSessionSummary[] }>(
      await this.transport.request("GET", "/api/tmux/sessions"),
    );
    return sessions;
  }

  /**
   * The scrollback the viewer was never sent, base64 with its escapes; empty when there is none.
   *
   * A tmux attach draws one screen, so everything before it exists only in tmux. This is how the
   * client gets the rest, which is what makes scrolling back reach further than the attach.
   */
  async terminalHistory(terminalId: string, lines: number): Promise<string> {
    const { data } = parse<AgentTerminalHistory>(await this.transport.request(
      "GET",
      `/api/terminals/${encodeURIComponent(terminalId)}/history?lines=${lines}`,
    ));
    return data;
  }

  /**
   * `replay` asks the PTY to resend the screen. A viewer that already has one says no.
   *
   * The replay begins by clearing the terminal, so a viewer that imported the pane's history and
   * then asked for a replay would watch its own history erased. Off, the screen it already wrote
   * stands and the live output continues it.
   */
  subscribeTerminal(
    terminalId: string,
    handlers: TerminalViewer,
    { replay = true }: { replay?: boolean } = {},
  ): () => void {
    const viewers = this.terminalViewers.get(terminalId) ?? new Set<TerminalViewer>();
    viewers.add(handlers);
    this.terminalViewers.set(terminalId, viewers);
    const streaming = this.openTerminalStream();
    if (!replay) return this.terminalViewerRelease(terminalId, handlers);
    // After the viewer is registered AND the stream is carrying, never before: the replay is what
    // paints the screen that was already there, and it is published once to whoever is listening.
    void streaming
      .then(() => this.transport
        .request("POST", `/api/terminals/${encodeURIComponent(terminalId)}/checkpoint`))
      .then((response) => {
        if (response.status >= 200 && response.status < 300) return;
        handlers.onError?.(`Terminal replay was refused with ${response.status}`);
      })
      .catch(() => handlers.onError?.("Terminal replay could not be requested"));
    return this.terminalViewerRelease(terminalId, handlers);
  }

  private terminalViewerRelease(terminalId: string, handlers: TerminalViewer): () => void {
    return () => {
      const live = this.terminalViewers.get(terminalId);
      if (!live) return;
      live.delete(handlers);
      if (live.size === 0) this.terminalViewers.delete(terminalId);
      if (this.terminalViewers.size === 0) this.closeTerminalStream();
    };
  }

  private openTerminalStream(): Promise<void> {
    if (this.terminalStreamOpen) return this.terminalStreamOpen;
    let carrying = (): void => {};
    this.terminalStreamOpen = new Promise<void>((resolve) => { carrying = resolve; });
    // A stream that never opens is the failure this whole class of bug hides behind, and it is
    // silent by construction: no error, no log, no frame -- just a terminal that says it is opening
    // forever. It cost an evening once, when the dev server served HTTP/1.1 and this stream, being
    // the last one the panel asks for, sat waiting for one of six connections that the other
    // streams already held. Whatever the cause, the viewer is told rather than left reading a
    // label that is technically true.
    const stalled = setTimeout(
      () => this.failTerminalViewers(
        "Terminal stream did not open. The panel holds an event stream per surface, so this is"
        + " usually the origin refusing another connection -- check that it negotiates HTTP/2.",
      ),
      TERMINAL_STREAM_OPEN_TIMEOUT_MS,
    );
    this.terminalStream = this.transport.subscribe("/api/terminals/stream", {
      onOpen: () => { clearTimeout(stalled); carrying(); },
      onMessage: (payload) => {
        let envelope: AgentTerminalStreamEnvelope;
        try {
          envelope = JSON.parse(payload) as AgentTerminalStreamEnvelope;
        } catch {
          this.failTerminalViewers("Terminal stream returned malformed JSON");
          return;
        }
        // A terminal nobody is watching is not an error: its viewer can unsubscribe while its
        // last messages are still in flight.
        for (const viewer of this.terminalViewers.get(envelope.terminalId) ?? []) {
          viewer.onMessage(envelope.message);
        }
      },
      onError: (reason) => {
        clearTimeout(stalled);
        this.failTerminalViewers(reason);
      },
    });
    return this.terminalStreamOpen;
  }

  private closeTerminalStream(): void {
    this.terminalStream?.();
    this.terminalStream = null;
    this.terminalStreamOpen = null;
  }

  private failTerminalViewers(reason: string): void {
    for (const viewers of this.terminalViewers.values()) {
      for (const viewer of viewers) viewer.onError?.(reason);
    }
  }

  async sendTerminalInput(
    terminalId: string,
    data: string,
    encoding: "utf8" | "base64" = "utf8",
  ): Promise<void> {
    expectEmpty(await this.transport.request(
      "POST",
      `/api/terminals/${encodeURIComponent(terminalId)}/input`,
      { body: { data, encoding } },
    ));
  }

  /**
   * Delivers one composer turn through an already-open Agent Feed terminal.
   *
   * This is deliberately a paste followed by Return, not a sequence of synthetic key presses.
   * Claude and Codex both accept bracketed paste, which preserves a multiline prompt as one edit
   * instead of executing every line as it arrives. Escape is rendered visibly so text from the
   * composer cannot smuggle terminal control sequences into the owned pty.
   */
  async sendTerminalPrompt(terminalId: string, text: string): Promise<void> {
    const safeText = text.replaceAll("\u001b", "\u241b");
    const input = `\u001b[200~${safeText}\u001b[201~\r`;
    if (new TextEncoder().encode(input).byteLength > 64 * 1024) {
      throw new Error("Terminal prompt exceeds the 64 KiB input limit");
    }
    await this.sendTerminalInput(terminalId, input);
  }

  async updateTerminalViewport(
    terminalId: string,
    viewport: AgentTerminalViewport,
  ): Promise<void> {
    expectEmpty(await this.transport.request(
      "POST",
      `/api/terminals/${encodeURIComponent(terminalId)}/viewport`,
      { body: viewport },
    ));
  }

  /** Sent with `keepalive`, because the commonest time to close a terminal is by closing the page. */
  async closeTerminal(terminalId: string, mode: "detach" | "kill"): Promise<void> {
    expectEmpty(await this.transport.request(
      "POST",
      `/api/terminals/${encodeURIComponent(terminalId)}/close`,
      { body: { mode }, keepalive: true },
    ));
  }

  // ---------------------------------------------------------------------
  // Transcript
  // ---------------------------------------------------------------------

  async fetchEventsPage(
    session: SessionReference,
    offset: number,
    limit: number,
  ): Promise<EventsPage> {
    const page = parse<WireEventsPage>(
      await this.transport.request("GET", eventsPath(session, offset, limit)),
    );
    return { events: page.events, total: page.total, usage: page.usage ?? null };
  }

  /**
   * Opens a thread.
   *
   * One stream, not four. The sidecar decides where the opening window starts, follows the
   * durable record from that window's own sequence so no row arrives twice, and opens the live
   * tail and extension UI only for a session whose capabilities warrant them. All of that used to
   * be orchestrated by whoever held the connection, from a capability table it kept a copy of.
   */
  subscribeSessionEvents(
    session: SessionReference,
    _after: number,
    handlers: SessionEventsHandlers,
  ): () => void {
    return this.transport.subscribe(timelinePath(session), {
      onOpen: () => handlers.onOpen?.(),
      onMessage: (payload) => {
        const message = JSON.parse(payload) as TimelineMessage;
        this.deliver(message, handlers);
      },
      // An error before the stream ever opened and one after it was running are the same thing to
      // the viewer: the thread is not live and it should say so.
      onError: () => handlers.onError?.(),
    });
  }

  /**
   * Follows the session's background tasks.
   *
   * The sidecar only sends when something actually changed, so this stream is quiet while one
   * long task runs. Elapsed time is re-derived on the client from `startedAt` for the same
   * reason -- a clock that ticked on the wire would defeat the suppression entirely.
   */
  subscribeBackgroundTasks(
    session: SessionReference,
    handlers: {
      onSnapshot: (snapshot: BackgroundTaskSnapshot) => void;
      onError?: (reason: string) => void;
    },
  ): () => void {
    return this.transport.subscribe(tasksPath(session), {
      onMessage: (payload) => handlers.onSnapshot(JSON.parse(payload) as BackgroundTaskSnapshot),
      onError: (reason) => handlers.onError?.(reason),
    });
  }

  /** Follows one task's output. Opened on expand, closed on collapse. */
  subscribeTaskOutput(
    session: SessionReference,
    taskId: string,
    handlers: {
      onMessage: (message: TaskOutputMessage) => void;
      onError?: (reason: string) => void;
    },
  ): () => void {
    return this.transport.subscribe(taskOutputPath(session, taskId), {
      onMessage: (payload) => handlers.onMessage(JSON.parse(payload) as TaskOutputMessage),
      onError: (reason) => handlers.onError?.(reason),
    });
  }

  private deliver(message: TimelineMessage, handlers: SessionEventsHandlers): void {
    switch (message.type) {
      case "timeline": {
        const envelope = message.envelope;
        const state: AgentSessionState = {
          sequence: envelope.sequence,
          runState: envelope.runState ?? "idle",
          queue: envelope.queue ?? { steer: 0, followUp: 0 },
        };
        handlers.onState?.(state);
        // Usage rides the envelope rather than its own message, and has to land whether the
        // envelope is the opening snapshot or a later chunk.
        if (envelope.usage !== undefined) handlers.onUsage?.(envelope.usage ?? null);
        if (envelope.kind === "snapshot") {
          handlers.onSnapshot({
            events: envelope.events,
            total: envelope.total,
            usage: envelope.usage ?? null,
            windowStart: envelope.windowStart ?? 0,
            state,
          });
          return;
        }
        for (const event of envelope.events) handlers.onEvent(event);
        return;
      }
      case "tail":
        handlers.onLiveTail?.(message.event);
        return;
      case "ui":
        this.uiListeners.forEach((listener) => listener(message.event));
        return;
      case "error":
        handlers.onError?.();
        return;
    }
  }

  /**
   * The exact original transcript line for one visible event.
   *
   * Plain text, not JSON: the whole promise of this view is that it shows the file's bytes, and
   * re-encoding them as a JSON string to decode them again is a chance to change them.
   */
  async fetchRawEvent(session: SessionReference, eventIndex: number): Promise<string> {
    const response = await this.transport.request(
      "GET",
      `/api/sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/events/${eventIndex}/raw?mode=${session.mode}`,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new SidecarError("raw-event-failed", `sidecar answered ${response.status}`, response.status);
    }
    return response.body;
  }

  // ---------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------

  /**
   * Creates a session and answers with its descriptor, not a receipt.
   *
   * The caller opens the thread it just made, so a request id it would have to correlate against
   * a later list refresh would be a race it has no way to win.
   */
  async createSession(projectPath: string, source = "pi"): Promise<AgentSessionDescriptor> {
    return parse<AgentSessionDescriptor>(
      await this.transport.request("POST", "/api/agent-sessions", {
        body: { source, projectPath },
      }),
    );
  }

  async sendMessage(
    session: SessionAddress,
    text: string,
    delivery: "next" | "steer",
  ): Promise<AgentCommandReceipt> {
    return parse<AgentCommandReceipt>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/messages`,
        { body: { text, delivery } },
      ),
    );
  }

  /**
   * Whether a Claude session running in someone's terminal can be typed into, and how it was
   * launched.
   *
   * Read rather than derived from `capabilities`, because it is a fact about a PROCESS and the
   * capabilities describe a session. A CLI session's row looks identical whether its terminal is
   * open or was closed an hour ago; only the harness's live registry knows the difference.
   */
  async cliInputStatus(session: SessionAddress): Promise<CliInputStatus> {
    return parse<CliInputStatus>(
      await this.transport.request("GET", cliInputPath(session)),
    );
  }

  /**
   * Puts one turn in a running CLI session's inbox.
   *
   * Resolves with `delivered: false` rather than throwing when the session cannot take it: a
   * closed terminal is an outcome the composer explains, not an exception. It still throws for a
   * refused request (an empty or oversized turn), which is the panel's own bug.
   */
  async sendCliInput(session: SessionAddress, text: string): Promise<CliInputReceipt> {
    return parse<CliInputReceipt>(
      await this.transport.request("POST", cliInputPath(session), { body: { text } }),
    );
  }

  /**
   * What the session's own terminal composer holds, and again whenever it changes.
   *
   * A stream rather than a read, and there is deliberately no read form. The composer changes
   * when somebody types, which is an event the pane already publishes; asking on a timer instead
   * cost a `capture-pane` a second for as long as a session was open, and answered "the same as
   * last time" nearly every time. The sidecar reports only differences, so an idle session -- the
   * state a composer spends nearly all its life in -- costs nothing at all.
   *
   * Returns unsubscribe, and the caller must call it.
   */
  subscribeTmuxComposer(
    session: SessionAddress,
    onState: (state: TmuxComposerState) => void,
  ): () => void {
    return this.transport.subscribe(tmuxComposerPath(session, "/stream"), {
      onMessage: (payload) => onState(JSON.parse(payload) as TmuxComposerState),
      // Silent by design: the panel already surfaces a sidecar that has stopped answering, and an
      // `EventSource` reconnects on its own. A session that had no pane when this was opened is
      // also the commonest reason to be here, and it is not a fault.
      onError: () => {},
    });
  }

  /**
   * Asks for the session's terminal composer to read `text`.
   *
   * The whole desired text, never the keystrokes: only the sidecar can see what the box currently
   * holds, and it reads it in the same breath as it writes. A delta computed here would be
   * computed against an observation that has already made a round trip, and the person at that
   * keyboard is typing too.
   */
  async syncTmuxComposer(session: SessionAddress, text: string): Promise<TmuxComposerState> {
    return parse<TmuxComposerState>(
      await this.transport.request("POST", tmuxComposerPath(session), { body: { text } }),
    );
  }

  /** Presses Return in the session's pane, which is what makes it take the turn. */
  async submitTmuxComposer(session: SessionAddress): Promise<TmuxComposerState> {
    return parse<TmuxComposerState>(
      await this.transport.request("POST", tmuxComposerPath(session, "/submit")),
    );
  }

  /**
   * Presses Tab, which is how Claude's own suggestion becomes text in its box.
   *
   * A key rather than a push of the hint's words, because what accepting a suggestion means
   * belongs to Claude. What the box then holds arrives on the stream like any other change.
   */
  async acceptTmuxComposerHint(session: SessionAddress): Promise<TmuxComposerState> {
    return parse<TmuxComposerState>(
      await this.transport.request("POST", tmuxComposerPath(session, "/accept")),
    );
  }

  /**
   * Presses one key rail key in the session's prompt box.
   *
   * The key goes over NAMED, not as the bytes it means. The sidecar owns the mapping because it is
   * the side writing into the pane, and both sides read it from the same module on the wire, so a
   * key cannot come to mean one thing here and another there.
   *
   * Nothing comes back but the reason: an arrow moves a cursor and Escape may clear the box, and
   * what the composer holds after either arrives on the stream like every other change.
   */
  async pressTmuxComposerKey(
    session: SessionAddress,
    key: RailKey,
    modifiers: RailModifiers,
  ): Promise<TmuxComposerState> {
    return parse<TmuxComposerState>(
      await this.transport.request("POST", tmuxComposerPath(session, "/key"), {
        body: { key, modifiers } satisfies ComposerKeyPress,
      }),
    );
  }

  /**
   * Hands one image to the session's composer.
   *
   * The bytes go over, never a path, and none comes back. The sidecar that answers this is the
   * process on the machine the pane is on -- which may not be this one, and need not be a Mac at
   * all from the panel's side -- so it is the only party that can write a file that pane's Claude
   * can read. A drop is therefore a transfer, not a reference.
   *
   * Base64 because the transport is JSON on both arms: in the webview it is a relay of text
   * frames, so binary would be encoded there regardless.
   */
  async dropTmuxComposerImage(session: SessionAddress, image: Blob): Promise<TmuxComposerState> {
    return parse<TmuxComposerState>(
      await this.transport.request("POST", tmuxComposerPath(session, "/image"), {
        body: { data: await base64FromBlob(image) } satisfies ComposerImageDrop,
      }),
    );
  }

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

  async abortSession(session: SessionAddress): Promise<AgentCommandReceipt> {
    return parse<AgentCommandReceipt>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/abort`,
        { body: {} },
      ),
    );
  }

  async respondToExtensionUI(
    session: SessionAddress,
    requestId: string,
    value: unknown,
  ): Promise<void> {
    parse<unknown>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/ui/${encodeURIComponent(requestId)}`,
        { body: { value } },
      ),
    );
  }

  // ---------------------------------------------------------------------
  // Extension UI
  // ---------------------------------------------------------------------

  private readonly uiListeners = new Set<(event: AgentUiEvent) => void>();

  /**
   * Listens for extension-UI events on whichever thread is open.
   *
   * They arrive on the thread's own stream rather than a separate subscription, because a prompt
   * belongs to the session that asked it: a second stream keyed by session id could outlive the
   * thread and answer for one the viewer had already left.
   */
  subscribeExtensionUI(listener: (event: AgentUiEvent) => void): () => void {
    this.uiListeners.add(listener);
    return () => {
      this.uiListeners.delete(listener);
    };
  }
}

export type { ActivityEvent, ProjectSummary, SessionSummary, TokenUsage };
