// Every terminal viewer on one connection, dispatched by id.
//
// Its own object rather than four private methods on the data source, because it is the only
// part of that class with state to keep: three fields that have to agree about whether a stream
// is open, and a map whose emptiness is what closes it. Everything else there is a route call.

import type {
  AgentTerminalStreamEnvelope,
  AgentTerminalStreamMessage,
} from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";

export interface TerminalViewer {
  onMessage: (message: AgentTerminalStreamMessage) => void;
  onError?: (reason: string) => void;
}

/**
 * How long a terminal may sit on "opening" before the viewer is told the stream never carried.
 *
 * Generous: this is the connect time of an SSE stream over a tailnet that may be relaying through
 * DERP, not a request budget. Short enough that a starved stream is a visible failure rather than
 * a terminal nobody can explain.
 */
const TERMINAL_STREAM_OPEN_TIMEOUT_MS = 8_000;

export class TerminalViewers {
  constructor(private readonly transport: AgentHttpTransport) {}

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

  /**
   * `replay` asks the PTY to resend the screen. A viewer that already has one says no.
   *
   * The replay begins by clearing the terminal, so a viewer that imported the pane's history and
   * then asked for a replay would watch its own history erased. Off, the screen it already wrote
   * stands and the live output continues it.
   */
  subscribe(
    terminalId: string,
    handlers: TerminalViewer,
    { replay = true }: { replay?: boolean } = {},
  ): () => void {
    const viewers = this.terminalViewers.get(terminalId) ?? new Set<TerminalViewer>();
    viewers.add(handlers);
    this.terminalViewers.set(terminalId, viewers);
    const streaming = this.open();
    if (!replay) return this.release(terminalId, handlers);
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
    return this.release(terminalId, handlers);
  }

  private release(terminalId: string, handlers: TerminalViewer): () => void {
    return () => {
      const live = this.terminalViewers.get(terminalId);
      if (!live) return;
      live.delete(handlers);
      if (live.size === 0) this.terminalViewers.delete(terminalId);
      if (this.terminalViewers.size === 0) this.close();
    };
  }

  private open(): Promise<void> {
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
      () => this.fail(
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
          this.fail("Terminal stream returned malformed JSON");
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
        this.fail(reason);
      },
    });
    return this.terminalStreamOpen;
  }

  private close(): void {
    this.terminalStream?.();
    this.terminalStream = null;
    this.terminalStreamOpen = null;
  }

  private fail(reason: string): void {
    for (const viewers of this.terminalViewers.values()) {
      for (const viewer of viewers) viewer.onError?.(reason);
    }
  }
}
