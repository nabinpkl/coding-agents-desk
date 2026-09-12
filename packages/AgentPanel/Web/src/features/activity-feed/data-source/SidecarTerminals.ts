// Agent terminal: opening one, and everything said to one that is open.
//
// The fan-out over the shared stream is its own object (`sidecarTerminalStream.ts`) because it is
// the only part with state to keep. What is here is the route calls around it: what a terminal
// can be pointed at, the scrollback a viewer was never sent, and the four ways to write to one.

import type {
  AgentTerminalContext,
  AgentTerminalDescriptor,
  AgentTerminalHistory,
  AgentTerminalViewport,
  TmuxSessionSummary,
} from "@agentdesk/agent-feed-wire";
import { expectEmpty, parse } from "@/features/activity-feed/data-source/sidecarRoutes";
import { SidecarComposers } from "@/features/activity-feed/data-source/SidecarComposers";
import { TerminalViewers, type TerminalViewer } from "@/features/activity-feed/data-source/sidecarTerminalStream";

export class SidecarTerminals extends SidecarComposers {
  private readonly terminals = new TerminalViewers(this.transport);
  /**
   * The tail of each terminal's write chain, so the next write waits for the one before it.
   *
   * Keyed by terminal rather than held globally: two terminals have nothing to say to each other,
   * and one slow write should not hold up a different session's typing.
   *
   * Entries delete themselves when a chain drains, so a terminal that ends without a close --
   * a page discarded, a pty that exited -- leaves nothing behind.
   */
  private readonly writeChains = new Map<string, Promise<void>>();

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
    options: { replay?: boolean } = {},
  ): () => void {
    return this.terminals.subscribe(terminalId, handlers, options);
  }

  /**
   * One write, queued behind everything already on its way to the same terminal.
   *
   * Every write is its own request and its own write to the pty, and that is deliberate rather
   * than incidental: the far end is a TUI, and a keystroke is not the same event as a chunk of
   * text arriving at once. Claude's own composer, readline, fzf and zsh's autosuggestions all
   * behave differently for a burst that lands in one `read` than for the same characters typed,
   * so merging the queue into one body would make a person's typing read as a machine's paste.
   * A real paste already arrives from xterm as a single `onData` and stays a single write, which
   * is the distinction being preserved rather than erased.
   *
   * What the chain fixes is order. These were fired and forgotten, so N+1 could leave while N was
   * still in flight and the two could be handled in either order: measured through the IDE's new
   * terminal, `echo ide-terminal-$PWD` arrived at the shell as `echo ide-etinrmla-$PWD`. Waiting
   * for the response rather than for the request to be written is stronger than strictly needed,
   * and it is the only completion a browser can observe.
   *
   * The tail swallows a rejection so one refused write cannot wedge the terminal shut. The caller
   * still gets the rejection, on the promise this returns.
   */
  sendTerminalInput(
    terminalId: string,
    data: string,
    encoding: "utf8" | "base64" = "utf8",
  ): Promise<void> {
    const written = (this.writeChains.get(terminalId) ?? Promise.resolve())
      .then(() => this.writeToTerminal(terminalId, data, encoding));
    const tail = written.then(() => {}, () => {});
    this.writeChains.set(terminalId, tail);
    // Only when nothing queued up behind this one, which is what makes the map hold the terminals
    // being typed into rather than every terminal ever opened.
    void tail.then(() => {
      if (this.writeChains.get(terminalId) === tail) this.writeChains.delete(terminalId);
    });
    return written;
  }

  private async writeToTerminal(
    terminalId: string,
    data: string,
    encoding: "utf8" | "base64",
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
}
