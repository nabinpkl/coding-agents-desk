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
} from "@agentdesk/agent-feed-wire";
import { parse, type SessionAddress } from "@/features/activity-feed/data-source/sidecarRoutes";
import { SidecarTerminals } from "@/features/activity-feed/data-source/layers/SidecarTerminals";

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
}
