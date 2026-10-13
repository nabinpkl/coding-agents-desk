/**
 * The `/api/agent-sessions/*` commands: starting a session, talking to one, stopping one, and
 * handing one to opencode.
 *
 * One more layer in the chain `sidecarRoutes.ts` describes: SidecarDataSource inherits the
 * terminals, the composers and the transcript from the layers under it, and the agent sessions
 * from this one. A session command is a request with an answer, so these are the thinnest calls
 * in the tree -- the handover is the exception, and only because the sidecar renders its prompt
 * while the panel only names the session and the message to send with it.
 */

import type {
  AgentCommandReceipt,
  AgentSessionDescriptor,
  SourceId,
  StartedSession,
} from "@agentdesk/agent-feed-wire";
import { parse, type SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import { SidecarTerminals } from "@/features/activity-feed/data-source/layers/SidecarTerminals";

/** One model the serve offers, as the picker shows it. Costs are USD per million tokens. */
export interface OpencodeModel {
  providerID: string;
  modelID: string;
  name: string;
  contextLimit: number | null;
  inputCost: number | null;
  outputCost: number | null;
}

/**
 * One slash command, as the composer menu shows it: the name the row carries, the web client's
 * own description, and any other spelling that reaches the same command.
 */
export interface OpencodeSlashCommand {
  name: string;
  description?: string;
  aliases?: string[];
}

export class SidecarAgentSessions extends SidecarTerminals {
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

  /**
   * Starts an opencode session carrying a compacted Claude session's context.
   *
   * One call for create plus first prompt, because the sidecar owns both halves and the panel
   * must never strand a created-but-never-prompted session between two calls. The message rides
   * last in the prompt the new session receives. Answers with the new descriptor, which the
   * caller attaches wherever the handover was asked from.
   */
  async handoverToOpencode(sessionId: string, message?: string): Promise<{
    session: AgentSessionDescriptor;
    handover: { turnCount: number; chars: number; lossy: boolean };
  }> {
    return parse<{
      session: AgentSessionDescriptor;
      handover: { turnCount: number; chars: number; lossy: boolean };
    }>(
      await this.transport.request("POST", "/api/agent-sessions/opencode/handover", {
        body: { requestId: crypto.randomUUID(), sessionId, ...(message ? { message } : {}) },
      }),
    );
  }

  /**
   * Starts a Claude session carrying a compacted opencode session's context.
   *
   * The mirror of the call above, and a separate method rather than a destination argument
   * because the two answer differently: opencode answers with a session descriptor the backend
   * made, Claude with the pane that was started. One call for the same reason -- a Claude session
   * is created and given its first turn by one argv, so there is no half-done state to strand.
   */
  /**
   * `botId` puts the started session on that Bot inside the same request. It has to be there
   * rather than in a second attach: a Claude session is not in the catalog until its first turn
   * writes a transcript, and the attach resolves against the catalog.
   */
  async handoverToClaude(sessionId: string, message?: string, botId?: string): Promise<{
    session: StartedSession;
    handover: { turnCount: number; chars: number; lossy: boolean };
  }> {
    return parse<{
      session: StartedSession;
      handover: { turnCount: number; chars: number; lossy: boolean };
    }>(
      await this.transport.request("POST", "/api/agent-sessions/claude/handover", {
        body: {
          requestId: crypto.randomUUID(),
          sessionId,
          ...(message ? { message } : {}),
          ...(botId ? { botId } : {}),
        },
      }),
    );
  }

  async sendMessage(
    session: SessionAddress,
    text: string,
    delivery: "next" | "steer",
    files?: { data: string; mime: string; name: string }[],
  ): Promise<AgentCommandReceipt> {
    return parse<AgentCommandReceipt>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/messages`,
        { body: { requestId: crypto.randomUUID(), text, delivery, ...(files?.length ? { files } : {}) } },
      ),
    );
  }

  async abortSession(session: SessionAddress): Promise<AgentCommandReceipt> {
    return parse<AgentCommandReceipt>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/${encodeURIComponent(session.source)}/${encodeURIComponent(session.sessionId)}/abort`,
        { body: { requestId: crypto.randomUUID() } },
      ),
    );
  }

  /**
   * What an opencode session offers after a slash: the serve's own custom commands plus the
   * panel-run set, which the sidecar mirrors from opencode's web client.
   *
   * Read when the composer opens rather than on every keystroke: the list is one small GET
   * and the draft filters it locally, so typing never waits on the sidecar.
   */
  async listOpencodeCommands(): Promise<OpencodeSlashCommand[]> {
    return parse<{ commands: OpencodeSlashCommand[] }>(
      await this.transport.request("GET", "/api/agent-sessions/opencode/commands"),
    ).commands;
  }

  /**
   * Runs one slash command natively, with the draft's remainder as its arguments.
   *
   * Separate from `sendMessage` because the serve treats prompt text starting with `/name`
   * as literal text (measured) -- only this route expands the template.
   *
   * Answers with the session too when the command made one (`/fork`): the panel attaches and
   * opens it, and a request id it would have to correlate against a later catalog refresh is a
   * race it has no way to win.
   */
  async runOpencodeCommand(sessionId: string, name: string, text: string): Promise<AgentCommandReceipt> {
    return parse<AgentCommandReceipt>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/opencode/${encodeURIComponent(sessionId)}/command`,
        { body: { requestId: crypto.randomUUID(), name, text } },
      ),
    );
  }

  /**
   * `/btw`: one answer from the session's context, adding nothing to the conversation. Its own
   * route because it starts no turn -- there is no receipt to correlate -- and the answer is
   * the whole payload.
   */
  async askOpencodeAside(sessionId: string, question: string): Promise<string> {
    return parse<{ text: string }>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/opencode/${encodeURIComponent(sessionId)}/aside`,
        { body: { question } },
      ),
    ).text;
  }

  /** `/export`: the whole projected transcript, as the web client writes it to a file. */
  async exportOpencodeTranscript(sessionId: string): Promise<unknown> {
    return parse<{ transcript: unknown }>(
      await this.transport.request("GET", `/api/agent-sessions/opencode/${encodeURIComponent(sessionId)}/export`),
    ).transcript;
  }

  /**
   * Renames an opencode session, which is what the row's Rename asks for.
   *
   * Its own route rather than `runOpencodeCommand("rename", ...)`: the two are one rename at the
   * serve, and this one does not open the session to run against, so naming a session nobody has
   * open does not start watching it. Answers with the title the serve stored, the shape Claude's
   * rename answers with, so the dialog treats both sources the same way.
   */
  async renameOpencodeSession(sessionId: string, title: string): Promise<string> {
    const answer = parse<{ title?: unknown }>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/opencode/${encodeURIComponent(sessionId)}/title`,
        { body: { title } },
      ),
    );
    if (typeof answer.title !== "string") throw new Error("Rename returned no title");
    return answer.title;
  }

  /**
   * Names what a Bot's session is doing: the session's own rename, to its Bot's anchor with this
   * task bracketed after it. An empty task leaves the bare anchor. The same route `set_task` uses.
   */
  async setSessionTask(source: SourceId, sessionId: string, task: string): Promise<void> {
    parse<unknown>(
      await this.transport.request(
        "POST",
        `/api/sessions/${encodeURIComponent(source)}/${encodeURIComponent(sessionId)}/bracket`,
        { body: { task } },
      ),
    );
  }

  /**
   * Every model the serve offers, with context limits and per-MTok costs for the picker.
   *
   * Read when the models dialog opens rather than held: seventy entries are one small GET,
   * and a model added mid-session must appear without a restart lecture.
   */
  async listOpencodeModels(): Promise<OpencodeModel[]> {
    return parse<{ models: OpencodeModel[] }>(
      await this.transport.request("GET", "/api/agent-sessions/opencode/models"),
    ).models;
  }

  /**
   * Switches the session's model; the serve holds it, and the meter reads it back off this
   * session's own projection.
   */
  async switchOpencodeModel(sessionId: string, providerID: string, modelID: string): Promise<AgentCommandReceipt> {
    return parse<AgentCommandReceipt>(
      await this.transport.request(
        "POST",
        `/api/agent-sessions/opencode/${encodeURIComponent(sessionId)}/model`,
        { body: { requestId: crypto.randomUUID(), providerID, modelID } },
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
}
