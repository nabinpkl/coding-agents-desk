// One session's side of the hub stream: keep one stream open for it, reconnecting with backoff,
// and hand each message to whoever delivers it. Confirming is the deliverer's call, because only it
// knows when the message has actually reached the session.
//
// The relay child delivers a channel notification and confirms straight after writing it. The hub
// reader (`hubReader.ts`) hands the message on to a mod and confirms nothing: the mod confirms once
// the message's prompt has entered the session. OpenCode sessions have no channel, so the same
// message is written as a prompt through the sidecar's adapter; the hub contract either side sees is
// identical, which is why this loop serves them all.

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
/**
 * Text that cannot write a tag: every "<" and its fullwidth and small lookalikes, escaped. Claude
 * Code wraps this content in its own <channel> tag, and the hub's refusal of a tag in a body is a
 * second layer, not the only one: a check that matches spellings misses one sooner or later.
 */
function withoutTags(text: string): string {
  return text.replace(/[<\uFF1C\uFE64]/g, "&lt;");
}

export function channelNotification(message: Message, fromName: string): ChannelNotification {
  return {
    content: withoutTags(`${message.body}${describeRefs(message.refs)}`),
    meta: {
      message_id: message.id,
      thread_id: message.threadId,
      from: message.from,
      from_name: withoutTags(fromName),
      from_kind: message.fromKind,
      kind: message.kind,
      hops: String(message.hops),
      ...(message.inReplyTo ? { in_reply_to: message.inReplyTo } : {}),
    },
  };
}

/** One message the hub pushed, with the stream it came on, which a confirmation has to name. */
export interface StreamDelivery {
  message: Message;
  fromName: string;
  streamId: string;
}

/** Tells the hub a message reached its session. Refused when it was not waiting on that stream. */
export async function confirmDelivery(hub: HubClient, messageId: string, streamId: string): Promise<Message> {
  return hub.request<Message>("POST", `/v1/messages/${encodeURIComponent(messageId)}/delivered`, { stream: streamId });
}

export interface ChannelLoopDeps {
  hub: HubClient;
  readSession: () => RelaySession | string;
  /**
   * Hands one message on. Resolving does not confirm it; a deliverer that has put the message in
   * front of the session calls `confirmDelivery` itself. Throwing ends the stream, and the hub
   * requeues whatever was not confirmed.
   */
  deliver: (delivery: StreamDelivery) => Promise<void>;
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
      deps.log(`hub stream idle: ${session}`);
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
            deps.log(`hub stream connected as ${event.address} (channel ${event.channel ? "on" : "off"})`);
            return;
          }
          // Directives ride the same stream vocabulary but are never pushed to a Claude stream;
          // ignored here rather than notified, so a future one cannot become a channel message.
          if (event.type !== "message") return;
          await deps.deliver({ message: event.message, fromName: event.fromName, streamId: event.streamId });
        },
        connection.signal,
      );
      deps.log("hub stream ended");
    } catch (error) {
      if (!connection.signal.aborted) deps.log(`hub stream failed: ${error instanceof Error ? error.message : String(error)}`);
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
