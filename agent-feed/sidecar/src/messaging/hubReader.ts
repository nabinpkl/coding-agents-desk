// The hub reader: holds one Claude session's hub stream on behalf of a mod, which cannot hold one
// itself (a hooks module has no network of its own, and `$.http.fetch` gives up after 30 seconds).
// The mod starts it with `$.process.spawn` and reads its stdout, one JSON line per message.
//
// It never confirms a delivery. The mod confirms, through `hubConfirmMain.ts`, once the message's
// prompt has entered the session; until then the hub holds the message as pushed, and requeues it
// if this stream drops. See "Delivering into a Claude session through a mod" in
// docs/agent-messaging.md.
//
// Talk runs one way. A spawned child's stdin is written once and closed, so the mod cannot answer
// the reader, and the reader cannot learn from stdin that the mod is gone either. It finds out two
// ways instead: every heartbeat line it writes fails once the parent has gone, and its parent pid
// changes when it is reparented.

import type { Message } from "@agentdesk/agent-feed-wire";
import type { HubClient } from "@/messaging/hubClient";
import { runChannelLoop, type StreamDelivery } from "@/messaging/relayChannel";

/** What the reader writes on stdout, one per line. */
export type ReaderLine =
  | { type: "message"; streamId: string; fromName: string; message: Message }
  /** Carries nothing: writing it is how the reader finds out its parent has gone. */
  | { type: "beat" };

export function readerLine(line: ReaderLine): string {
  return `${JSON.stringify(line)}\n`;
}

export interface HubReaderOptions {
  hub: HubClient;
  sessionId: string;
  cwd: string;
  title: string;
  write: (line: string) => void;
  log: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Holds the session's stream until the signal aborts, as the one stream the hub has for it, opened
 * with the channel on so the hub chooses it for delivery.
 */
export function runHubReader(options: HubReaderOptions, signal: AbortSignal): Promise<void> {
  const session = {
    pid: process.ppid,
    sessionId: options.sessionId,
    cwd: options.cwd,
    title: options.title,
    channel: true,
  };
  return runChannelLoop(
    {
      hub: options.hub,
      readSession: () => session,
      deliver: async ({ message, fromName, streamId }: StreamDelivery) => {
        options.write(readerLine({ type: "message", streamId, fromName, message }));
      },
      log: options.log,
      ...(options.sleep ? { sleep: options.sleep } : {}),
    },
    signal,
  );
}

/**
 * Calls `gone` once the parent this process started under is no longer its parent. A timer,
 * because nothing tells a process its parent died: the write that fails is the other half, and it
 * only fires when there is something to write.
 */
export function watchParent(options: { parentPid: () => number; intervalMs: number; gone: () => void }): () => void {
  const started = options.parentPid();
  const timer = setInterval(() => {
    if (options.parentPid() !== started) {
      clearInterval(timer);
      options.gone();
    }
  }, options.intervalMs);
  return () => clearInterval(timer);
}
