// OpenCode's side of the agent messaging hub: one stream per opencode session on this machine,
// held by the sidecar rather than by a child per session.
//
// OpenCode runs one stdio MCP child per `opencode serve`, not per session, so there is no parent
// process to read a session id from. The sidecar is the one thing that already knows every session
// the serve lists, so it holds the streams: each opencode session gets a `opencode:<id>` stream,
// an incoming message is written as a queued prompt through the serve's own endpoint, and the
// delivery is confirmed to the hub only after that write returns.
//
// Reachability follows the serve, as the user said it should: while the serve answers, every
// session it lists is reachable, and a message to a session the serve has not listed waits.

import type { BotSessionRef, HubStreamEvent, Message, MessageRef, RenamedBracket } from "@agentdesk/agent-feed-wire";
import { opencodeClient, resetOpencodeClient, serveRequest } from "@/agents/opencode/opencodeClient";
import { subscribeCatalog } from "@/transcripts/catalog/catalogState";
import type { HubClient } from "@/messaging/hubClient";
import { agentKindLine, agentPreamble, ownerKindLine } from "@repo/agent-feed/sidecar/mods/agentdesk-hub/hooks/hubKindWording.ts";

/** One opencode session as the hub stream needs it. */
export interface OpencodeSessionRef {
  sessionId: string;
  cwd: string;
  title: string;
}

/** Where the adapter reads sessions and writes prompts. Injected so tests need no serve. */
export interface OpencodeServePort {
  /** Every session the serve currently lists. */
  sessions(): Promise<OpencodeSessionRef[]>;
  /** Writes one queued prompt. Rejects when the serve refuses it. */
  prompt(sessionId: string, requestId: string, text: string): Promise<void>;
  /** Fires when the serve's session list may have changed. */
  onChanged(listener: () => void): () => void;
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
/** How long a stream waits before its session list is re-read, so a vanished session closes. */
const RECHECK_MS = 30_000;

function describeRefs(refs: MessageRef[]): string {
  if (refs.length === 0) return "";
  const lines = refs.map((r) => `- ${r.app} ${r.kind} ${r.id}${r.url ? ` (${r.url})` : ""}`);
  return `\n\nRefs:\n${lines.join("\n")}`;
}

/**
 * The prompt a message becomes.
 *
 * The same shape the Claude channel carries in its meta, written into the text because a prompt
 * has no meta channel. A `<channel>` tag here is the hub's own envelope, not a claim by the sender:
 * the hub refuses any body that already contains one, so a message cannot arrive with the tag
 * forged.
 *
 * An opencode prompt is read as the person's own, so what the message is goes outside the tag, in
 * the words a Claude session is given (`hubKindWording.ts`): before it for another agent's message,
 * which carries none of the owner's authority and asks only what its kind says; after it for the
 * owner's, which says how to answer.
 */
export function messagePrompt(message: Message, fromName: string): string {
  const meta = [
    `message_id="${message.id}"`,
    `thread_id="${message.threadId}"`,
    `from="${message.from}"`,
    `from_name="${fromName}"`,
    `from_kind="${message.fromKind}"`,
    `kind="${message.kind}"`,
    `hops="${message.hops}"`,
  ].join(" ");
  const envelope = `<channel source="agentdesk-relay" ${meta}>\n${message.body}${describeRefs(message.refs)}\n</channel>`;
  if (message.fromKind === "human") return [envelope, "", ownerKindLine(message)].join("\n");
  return [agentPreamble("channel"), agentKindLine(message), "", envelope].join("\n");
}

export interface HubOpencodeDeps {
  hub: HubClient;
  serve: OpencodeServePort;
  log: (text: string) => void;
  /**
   * Renames one session's bracket through the Bot registry's completion path. Wired in server.ts,
   * where the registry and the opencode backend both exist; the adapter owns neither.
   */
  rename: (ref: BotSessionRef, task: string) => Promise<RenamedBracket>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * One hub stream per opencode session, kept until the session leaves the serve's list.
 *
 * Each stream is its own loop with its own abort controller. The session is re-read on a timer so
 * one the serve dropped has its stream closed, which puts any unconfirmed message back in the
 * queue rather than leaving it marked delivered to a session that is gone.
 */
export class HubOpencodeAdapter {
  private readonly streams = new Map<string, { controller: AbortController; session: OpencodeSessionRef }>();
  private readonly root = new AbortController();
  private serveUnsubscribe: (() => void) | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: HubOpencodeDeps) {}

  /** Starts watching the serve and holding streams. Idempotent. */
  start(): void {
    if (this.root.signal.aborted) return;
    if (this.serveUnsubscribe) return;
    this.serveUnsubscribe = this.deps.serve.onChanged(() => void this.sync());
    void this.sync();
  }

  /** Closes every stream. The hub requeues anything they had not confirmed. */
  stop(): void {
    this.root.abort();
    for (const { controller } of this.streams.values()) controller.abort();
    this.streams.clear();
    this.serveUnsubscribe?.();
    this.serveUnsubscribe = null;
  }

  /** Sessions with a live hub stream right now, for the sidecar's status route. */
  get connected(): string[] {
    return [...this.streams.keys()];
  }

  /** Opens a stream for every session the serve lists, and closes the ones it dropped. */
  async sync(): Promise<void> {
    let sessions: OpencodeSessionRef[];
    try {
      sessions = await this.deps.serve.sessions();
    } catch (error) {
      this.note(`cannot list opencode sessions: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const live = new Set(sessions.map((session) => session.sessionId));
    for (const [id, { controller }] of this.streams) {
      if (live.has(id)) continue;
      controller.abort();
      this.streams.delete(id);
      this.deps.log(`opencode stream closed for ${id}`);
    }
    const known = new Map(sessions.map((session) => [session.sessionId, session]));
    for (const [id, held] of this.streams) {
      const next = known.get(id);
      if (next && (next.cwd !== held.session.cwd || next.title !== held.session.title)) {
        held.controller.abort();
        this.streams.delete(id);
      }
    }
    for (const session of sessions) {
      if (this.streams.has(session.sessionId)) continue;
      const controller = new AbortController();
      this.root.signal.addEventListener("abort", () => controller.abort(), { once: true });
      this.streams.set(session.sessionId, { controller, session });
      void this.run(session, controller.signal);
    }
  }

  private note(text: string): void {
    if (text === this.lastError) return;
    this.lastError = text;
    this.deps.log(text);
  }

  /** The loop for one session. Reconnects with backoff until the session leaves the serve. */
  private async run(session: OpencodeSessionRef, signal: AbortSignal): Promise<void> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let failures = 0;
    while (!signal.aborted) {
      const held = this.streams.get(session.sessionId);
      // The reaper holds the live session record; a replacement is started by `sync`, not here.
      const current = held?.session ?? session;
      let openedThisTry = false;
      try {
        await this.deps.hub.stream(
          {
            session: current.sessionId,
            source: "opencode",
            channel: "1",
            cwd: current.cwd,
            title: current.title,
          },
          async (event: HubStreamEvent & { streamId: string }) => {
            if (event.type === "hello") {
              openedThisTry = true;
              failures = 0;
              this.lastError = null;
              this.deps.log(`opencode stream connected as ${event.address}`);
              return;
            }
            // A directive the hub pushed for this session: run it locally and confirm the outcome,
            // so the MCP caller waiting on it learns what happened. Never a prompt.
            if (event.type === "directive") {
              await this.answerDirective(event.id, current.sessionId, event.task);
              return;
            }
            await this.deliver(event.message, event.fromName, event.streamId);
          },
          signal,
        );
        if (signal.aborted) return;
        this.deps.log(`opencode stream ended for ${current.sessionId}`);
      } catch (error) {
        if (!signal.aborted) this.deps.log(`opencode stream failed for ${current.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (signal.aborted) return;
      if (!openedThisTry) failures += 1;
      await sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]!);
      // A reconnect reads the serve again, so a session dropped while we slept is not reopened.
      const listed = await this.deps.serve.sessions().catch(() => [] as OpencodeSessionRef[]);
      if (!listed.some((s) => s.sessionId === session.sessionId)) return;
    }
  }

  /** Writes the message as a prompt, then confirms it. A failed write leaves it for redelivery. */
  private async deliver(message: Message, fromName: string, streamId: string): Promise<void> {
    await this.deps.serve.prompt(message.deliveredTo?.replace(/^opencode:/, "") ?? "", message.id, messagePrompt(message, fromName));
    await this.deps.hub.request("POST", `/v1/messages/${message.id}/delivered`, { stream: streamId });
  }

  /**
   * Runs a rename-bracket directive and confirms what it did, so the waiting MCP call answers.
   *
   * A failure to run is still a confirmation, with `ok: false`: the directive is done either way
   * and must not wait out its clock on the hub while the answer sits here.
   */
  private async answerDirective(id: string, sessionId: string, task: string): Promise<void> {
    const ref = { source: "opencode" as const, sessionId };
    try {
      const done = await this.deps.rename(ref, task);
      await this.deps.hub.request("POST", `/v1/directives/${id}/done`, {
        ok: true,
        anchor: done.anchor,
        title: done.title,
        status: done.status,
      });
    } catch (error) {
      await this.deps.hub.request("POST", `/v1/directives/${id}/done`, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** The real serve: the client for listing, the raw POST for the prompt, and the serve event stream. */
export function liveOpencodeServePort(listChanged: () => void): OpencodeServePort {
  return {
    async sessions() {
      const client = opencodeClient();
      if (!client) return [];
      return (await client.session.list()).data.map((session) => ({
        sessionId: session.id,
        cwd: session.location.directory,
        title: session.title || "",
      }));
    },
    async prompt(sessionId, requestId, text) {
      // The message id is the request id, so a redelivery of the same message after a dropped
      // stream is one prompt the serve's own ledger recognises rather than a second turn.
      const answered = await serveRequest(`/api/session/${sessionId}/prompt`, { text, delivery: "queue", requestID: requestId });
      if (answered.status === 401) {
        resetOpencodeClient();
        throw new Error(`prompt: unauthorized (${answered.status})`);
      }
      if (answered.status < 200 || answered.status >= 300) {
        throw new Error(`prompt: serve answered ${answered.status} ${answered.text}`);
      }
    },
    onChanged(listener) {
      // The sidecar already holds one serve event stream and reconciles the catalog on every
      // session event, so the catalog broadcast is this adapter's trigger. A second event stream
      // would be a second connection for the same signal.
      let queued = false;
      return subscribeCatalog((sessions) => {
        if (queued || !sessions.some((session) => session.source === "opencode")) return;
        queued = true;
        setTimeout(() => {
          queued = false;
          listener();
        }, 0).unref?.();
      });
    },
  };
}
