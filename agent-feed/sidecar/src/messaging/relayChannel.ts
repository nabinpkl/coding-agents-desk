// The relay child's side of the hub stream: keep one stream open for this session, turn each
// message into a channel notification, and confirm it only after the notification was written.
//
// Claude Code sessions get a channel notification. OpenCode sessions have no channel, so the
// same message is written as a prompt through the sidecar's adapter; the hub contract either side
// sees is identical, which is why this loop serves both.

import type { Message, MessageRef, MessagingSource } from "@agentdesk/agent-feed-wire";
import type { HubClient } from "@/messaging/hubClient";
import type { RelaySession } from "@/messaging/relaySession";

export interface ChannelNotification {
  content: string;
  meta: Record<string, string>;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const SESSION_RECHECK_MS = 5_000;

function describeRefs(refs: MessageRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map((r) => `- ${r.app} ${r.kind} ${r.id}${r.url ? ` (${r.url})` : ""}`);
  return `\n\nRefs:\n${lines.join("\n")}`;
}

/** The notification a message becomes. Meta keys are identifiers only; Claude Code drops others. */
export function channelNotification(message: Message, fromName: string): ChannelNotification {
  return {
    content: `${message.body}${describeRefs(message.refs)}`,
    meta: {
      message_id: message.id,
      thread_id: message.threadId,
      from: message.from,
      from_name: fromName,
      from_kind: message.fromKind,
      kind: message.kind,
      hops: String(message.hops),
      ...(message.inReplyTo ? { in_reply_to: message.inReplyTo } : {}),
    },
  };
}

export interface ChannelLoopDeps {
  hub: HubClient;
  readSession: () => RelaySession | string;
  notify: (notification: ChannelNotification) => Promise<void>;
  log: (text: string) => void;
  /** Which runtime this child serves. Defaults to claude, the one started per session. */
  source?: MessagingSource;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs until the signal aborts. Reconnects with backoff, and reconnects at once when the session
 * behind this process changes (after /clear or a resume), so the hub always knows it by its
 * current id.
 */
export async function runChannelLoop(deps: ChannelLoopDeps, signal: AbortSignal): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const source = deps.source ?? "claude";
  let failures = 0;
  while (!signal.aborted) {
    const session = deps.readSession();
    if (typeof session === "string") {
      deps.log(`relay channel idle: ${session}`);
      await sleep(SESSION_RECHECK_MS * 6);
      continue;
    }
    const connection = new AbortController();
    const abort = () => connection.abort();
    signal.addEventListener("abort", abort, { once: true });
    const watcher = setInterval(() => {
      const now = deps.readSession();
      if (typeof now === "string" || now.sessionId !== session.sessionId || now.title !== session.title) connection.abort();
    }, SESSION_RECHECK_MS);
    let opened = false;
    try {
      await deps.hub.stream(
        {
          session: session.sessionId,
          source,
          channel: session.channel ? "1" : "0",
          cwd: session.cwd,
          title: session.title,
        },
        async (event) => {
          if (event.type === "hello") {
            opened = true;
            failures = 0;
            deps.log(`relay channel connected as ${event.address} (channel ${event.channel ? "on" : "off"})`);
            return;
          }
          await deps.notify(channelNotification(event.message, event.fromName));
          await deps.hub.request("POST", `/v1/messages/${event.message.id}/delivered`, { stream: event.streamId });
        },
        connection.signal,
      );
      deps.log("relay channel stream ended");
    } catch (error) {
      if (!connection.signal.aborted) deps.log(`relay channel stream failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearInterval(watcher);
      signal.removeEventListener("abort", abort);
    }
    if (signal.aborted) return;
    if (connection.signal.aborted) continue;
    failures = opened ? 0 : failures + 1;
    await sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!);
  }
}
