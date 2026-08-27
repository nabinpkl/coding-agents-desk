/**
 * The panel's native-authority client: the PTY lease, and the relay that carries everything else.
 *
 * This file used to argue that a composer write "should cost a Swift compile precisely because of
 * what it can do", and it carried the whole composer surface on that basis. The argument did not
 * survive contact with the rest of the codebase: ADR-0109 had already put `CGEvent` POSTING --
 * strictly more powerful than filling a text field -- behind the sidecar plus the standalone helper,
 * and AGENTS.md's test for keeping something native is to name the capability TypeScript cannot
 * provide. Composer POLICY has none. ADR-0110 moved both window composers to `/api/window/*`, where
 * the sidecar resolves and validates and the helper is the only thing holding `AXUIElement`. The
 * bound moved; it did not disappear.
 *
 * What is left is what genuinely needs this process: `agent-terminal-*` leases a PTY the host owns,
 * and `agent-http-*` is the opaque relay that carries everything above to the sidecar. The relay is
 * the one thing that cannot move at all -- it holds the control token, which must never reach a page
 * rendering agent-authored markdown.
 */

import type { HostBridge } from "./HostBridge";

export type AgentSource = string;

export interface AgentTerminalContext {
  projectPath: string;
  source: "claude" | "codex";
  sessionId: string;
}

export interface AgentTerminalRequest {
  requestId: string;
  context: AgentTerminalContext;
}

export type AgentTerminalStatus =
  | (AgentTerminalRequest & { kind: "ready"; ptySessionName: string })
  | (AgentTerminalRequest & { kind: "error"; code: string })
  | (AgentTerminalRequest & { kind: "ended"; ptySessionName: string; exitStatus?: number });

interface Watch<T> {
  sessionId: string;
  listener: (status: T) => void;
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HostActionsClientOptions {
  /** How long a composer or question action may take before it is abandoned. */
  actionTimeoutMs?: number;
  requestIDFactory?: (prefix: string) => string;
}

let nextRequestOrdinal = 0;

function defaultRequestID(prefix: string): string {
  nextRequestOrdinal += 1;
  return `${prefix}-${nextRequestOrdinal}`;
}

function terminalContext(value: unknown): AgentTerminalContext | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const source = raw.src;
  if (typeof raw.pp !== "string" || raw.pp.length === 0) return null;
  if (source !== "claude" && source !== "codex") return null;
  if (typeof raw.sid !== "string" || raw.sid.length === 0) return null;
  return { projectPath: raw.pp, source, sessionId: raw.sid };
}

function sameTerminalRequest(a: AgentTerminalRequest, b: AgentTerminalRequest): boolean {
  return (
    a.requestId === b.requestId &&
    a.context.projectPath === b.context.projectPath &&
    a.context.source === b.context.source &&
    a.context.sessionId === b.context.sessionId
  );
}

export class HostActionsClient {
  private readonly actionTimeoutMs: number;
  private readonly requestID: (prefix: string) => string;
  private readonly terminalListeners = new Set<(status: AgentTerminalStatus) => void>();
  private activeTerminalRequest: AgentTerminalRequest | null = null;
  private detach: (() => void) | null;
  private destroyed = false;

  constructor(
    private readonly bridge: HostBridge,
    options: HostActionsClientOptions = {},
  ) {
    this.actionTimeoutMs = options.actionTimeoutMs ?? 10_000;
    this.requestID = options.requestIDFactory ?? defaultRequestID;
    this.detach = bridge.onHostMessage((message) => this.receive(message));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.detach?.();
    this.detach = null;
    this.terminalListeners.clear();
  }

  // ---------------------------------------------------------------------
  // Terminal
  // ---------------------------------------------------------------------

  createTerminalRequest(context: AgentTerminalContext): AgentTerminalRequest {
    return { requestId: this.requestID("terminal"), context };
  }

  openTerminal(request: AgentTerminalRequest): void {
    if (this.destroyed) return;
    if (this.activeTerminalRequest && !sameTerminalRequest(this.activeTerminalRequest, request)) {
      this.endTerminalContext(this.activeTerminalRequest);
    }
    this.activeTerminalRequest = request;
    this.postTerminalIntent("agent-terminal-open", request);
  }

  closeTerminal(request: AgentTerminalRequest): void {
    if (this.destroyed) return;
    this.postTerminalIntent("agent-terminal-close", request);
  }

  endTerminalContext(request: AgentTerminalRequest): void {
    if (this.destroyed) return;
    this.postTerminalIntent("agent-terminal-context-ended", request);
    if (this.activeTerminalRequest && sameTerminalRequest(this.activeTerminalRequest, request)) {
      this.activeTerminalRequest = null;
    }
  }

  endActiveTerminalContext(): void {
    if (this.activeTerminalRequest) this.endTerminalContext(this.activeTerminalRequest);
  }

  subscribeTerminalStatus(listener: (status: AgentTerminalStatus) => void): () => void {
    this.terminalListeners.add(listener);
    return () => {
      this.terminalListeners.delete(listener);
    };
  }

  private postTerminalIntent(tag: string, request: AgentTerminalRequest): void {
    this.bridge.postToHost({
      t: tag,
      rid: request.requestId,
      ctx: {
        pp: request.context.projectPath,
        src: request.context.source,
        sid: request.context.sessionId,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Inbound
  // ---------------------------------------------------------------------

  private receive(message: unknown): void {
    if (this.destroyed) return;
    if (typeof message !== "object" || message === null) return;
    const frame = message as Record<string, unknown> & { t?: string };
    switch (frame.t) {
      case "agent-terminal-ready":
      case "agent-terminal-error":
      case "agent-terminal-ended": {
        const status = this.terminalStatus(frame);
        if (status) for (const listener of this.terminalListeners) listener(status);
        return;
      }
      default:
        return;
    }
  }

  private terminalStatus(frame: Record<string, unknown>): AgentTerminalStatus | null {
    const requestId = frame.rid;
    const context = terminalContext(frame.ctx);
    if (typeof requestId !== "string" || requestId.length === 0 || !context) return null;
    if (frame.t === "agent-terminal-ready") {
      if (typeof frame.psn !== "string" || frame.psn.length === 0) return null;
      return { kind: "ready", requestId, context, ptySessionName: frame.psn };
    }
    if (frame.t === "agent-terminal-error") {
      if (typeof frame.c !== "string" || frame.c.length === 0) return null;
      return { kind: "error", requestId, context, code: frame.c };
    }
    if (typeof frame.psn !== "string" || frame.psn.length === 0) return null;
    if (frame.xs !== undefined && typeof frame.xs !== "number") return null;
    return {
      kind: "ended",
      requestId,
      context,
      ptySessionName: frame.psn,
      exitStatus: frame.xs as number | undefined,
    };
  }
}
