// Generic cross-session relay router: Claude Code plus opencode only.
//
// Tools stay source free (send, notify, sessions_list, session_status) and
// this router decides the transport. Pi and Codex are out of scope and
// answer as unsupported rather than guessing.
//
// Claude send goes through the tmux composer (sync then submit), which the
// harness reads as the local user's own turn. Claude notify goes through
// the socket inbox, which the harness gates as a peer message. Opencode
// has one path, the serve prompt endpoint, for both.

import type { CliInputStatus } from "@agentdesk/agent-feed-wire";

export type RelaySource = "claude" | "opencode";

export interface SendResult {
  delivered: boolean;
  /** Machine readable reason when undelivered: no-pane, no-composer, not-running, etc. */
  reason: string | null;
}

export interface SessionStatus {
  found: boolean;
  source: RelaySource | null;
  /** Null when the source is unknown or unsupported. */
  detail: unknown;
}

export interface ListedSession {
  source: RelaySource;
  sessionId: string;
  project: string;
  lastEventAt: number;
  title?: string;
}

/** All side effects behind one seam so tests pin routing with fakes. */
export interface RelayDependencies {
  hasClaudeSession(sessionId: string): boolean;
  hasOpencodeSession(sessionId: string): boolean;
  claudeSend(sessionId: string, text: string): Promise<SendResult>;
  claudeNotify(sessionId: string, text: string): Promise<SendResult>;
  opencodePrompt(sessionId: string, text: string): Promise<SendResult>;
  claudeStatus(sessionId: string): Promise<CliInputStatus>;
  listSessions(): ListedSession[];
}

const CLAUDE_ID = /^[0-9a-f-]{36}$/i;
const OPENCODE_ID = /^ses_[A-Za-z0-9]+$/;

function validSessionId(sessionId: string): boolean {
  return CLAUDE_ID.test(sessionId) || OPENCODE_ID.test(sessionId);
}

export async function relaySend(
  deps: RelayDependencies,
  sessionId: string,
  text: string,
): Promise<SendResult> {
  if (!validSessionId(sessionId)) return { delivered: false, reason: "invalid-session-id" };
  if (text.trim() === "") return { delivered: false, reason: "text-required" };
  if (deps.hasClaudeSession(sessionId)) return deps.claudeSend(sessionId, text);
  if (deps.hasOpencodeSession(sessionId)) return deps.opencodePrompt(sessionId, text);
  return { delivered: false, reason: "unknown-session" };
}

export async function relayNotify(
  deps: RelayDependencies,
  sessionId: string,
  text: string,
): Promise<SendResult> {
  if (!validSessionId(sessionId)) return { delivered: false, reason: "invalid-session-id" };
  if (text.trim() === "") return { delivered: false, reason: "text-required" };
  if (deps.hasClaudeSession(sessionId)) return deps.claudeNotify(sessionId, text);
  // Opencode serve has no peer gate, so FYI travels the same prompt path
  // with a marker in the body.
  if (deps.hasOpencodeSession(sessionId)) return deps.opencodePrompt(sessionId, `[fyi] ${text}`);
  return { delivered: false, reason: "unknown-session" };
}

export async function relayStatus(
  deps: RelayDependencies,
  sessionId: string,
): Promise<SessionStatus> {
  if (!validSessionId(sessionId)) return { found: false, source: null, detail: { reason: "invalid-session-id" } };
  if (deps.hasClaudeSession(sessionId)) {
    return { found: true, source: "claude", detail: await deps.claudeStatus(sessionId) };
  }
  if (deps.hasOpencodeSession(sessionId)) {
    return { found: true, source: "opencode", detail: { reachable: true } };
  }
  return { found: false, source: null, detail: { reason: "unknown-session" } };
}

export function relayList(deps: RelayDependencies): ListedSession[] {
  return deps.listSessions();
}
