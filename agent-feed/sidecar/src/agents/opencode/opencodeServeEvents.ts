// One serve event stream for the process, fanned out per session.
//
// Shared rather than per session because the serve already multiplexes: every
// event carries its session, so N sessions cost one connection and a thread
// opened later joins whatever is already flowing. Split from the backend
// because the stream lifecycle plus permission answering is one idea and
// projections plus commands are another.

import type { OpencodeClient, V2Event } from "@opencode-ai/sdk/v2/client";
import { describeServeError, isServeUnauthorized, resetOpencodeClient } from "@/agents/opencode/opencodeClient";
import type { OpencodeStreamedPart } from "@/agents/opencode/opencodeStreamTail";
import type { AgentUiBroker } from "@/agents/agentUiBroker";

export type OpencodeRunState = "running" | "idle" | "error";

export interface ServeEventRouter {
  refresh(sessionId: string, full?: boolean): void;
  setRunState(sessionId: string, state: OpencodeRunState): void;
  catalogChanged(): void;
  hasSession(sessionId: string): boolean;
  uiFor(sessionId: string): AgentUiBroker | null;
  /** A compaction started streaming its summary; the durable row lands on `ended`. */
  compactionStarted(sessionId: string, messageId: string): void;
  /** One streamed delta of a running compaction's summary. */
  compactionDelta(sessionId: string, messageId: string, text: string): void;
  /**
   * One streamed delta that names the session but not the compaction: v2's
   * `session.compaction.delta` carries only `sessionID` plus text, so it appends to whatever is
   * newest there rather than to a named flow.
   */
  compactionDeltaForSession(sessionId: string, text: string): void;
  /** A compaction finished (or its checkpoint landed); the notice comes down. */
  compactionEnded(sessionId: string, messageId: string): void;
  /**
   * A running turn's prose or thinking advanced. Delivered to the projection rather than
   * re-read: the serve is publishing the words as they are written, so reading the messages
   * back would only arrive later, in steps, having re-read 200 of them to move one line.
   */
  streamPart(sessionId: string, part: OpencodeStreamedPart): void;
  /**
   * A checkpoint landed without naming its compaction (`session.compacted` carries only the
   * session). Ends whatever is running there: the notice must not outlive the row it waited on.
   */
  compactionSettled(sessionId: string): void;
}

type PermissionAsked = Extract<V2Event, { type: "permission.v2.asked" }>;
type QuestionAsked = Extract<V2Event, { type: "question.v2.asked" }>;
type CompactionStarted = Extract<V2Event, { type: "session.next.compaction.started" }>;
type CompactionDelta = Extract<V2Event, { type: "session.next.compaction.delta" }>;
type CompactionEnded = Extract<V2Event, { type: "session.next.compaction.ended" }>;

/** How long a dropped serve stream waits before redialing it. */
const STREAM_RETRY_MS = 5000;

export class OpencodeServeEvents {
  private readonly inflightUi = new Set<string>();
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private wanted = false;
  private disposed = false;

  constructor(
    private readonly router: ServeEventRouter,
    private readonly serve: () => OpencodeClient | null,
  ) {}

  setWanted(wanted: boolean): void {
    if (wanted === this.wanted || this.disposed) return;
    this.wanted = wanted;
    if (wanted) {
      this.loop = this.run().catch(() => {});
    } else {
      this.abort?.abort();
      this.abort = null;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abort?.abort();
    this.abort = null;
    await this.loop?.catch(() => {});
  }

  private async run(): Promise<void> {
    while (this.wanted && !this.disposed) {
      const client = this.serve();
      if (!client) {
        await sleep(STREAM_RETRY_MS);
        continue;
      }
      const abort = new AbortController();
      this.abort = abort;
      try {
        const result = await client.v2.event.subscribe({ signal: abort.signal });
        for await (const event of result.stream) {
          if (!this.wanted || this.disposed) break;
          this.route(event);
        }
      } catch (error) {
        if (!this.wanted || this.disposed) break;
        if (isServeUnauthorized(error)) resetOpencodeClient();
        console.error("opencode event stream failed, redialing", String(error));
        await sleep(STREAM_RETRY_MS);
      } finally {
        if (this.abort === abort) this.abort = null;
      }
    }
  }

  private route(event: V2Event): void {
    const sessionId = serveEventSession(event);
    // v2's compaction family, which the pinned v1 SDK union does not name: the raw JSON still
    // arrives over the same SSE stream, so dispatch on the string rather than the union. v1's
    // `session.next.compaction.*` keeps its cases below for older serves; the live one (v2.0.16)
    // emits only these.
    if (typeof (event as { type?: unknown }).type === "string") {
      const type = (event as { type: string }).type;
      if (type.startsWith("session.compaction.")) {
        this.routeCompactionV2(type, event, sessionId);
        return;
      }
      // A running turn's own words, dispatched before the catch-all below for the reason the
      // compaction family is: these arrive per chunk, and every one of them used to buy a
      // re-read of the newest page. The durable read now waits for the step to end instead.
      // Recognised by the family and not by whether the event parses, so an event this shape
      // cannot draw -- no session, no message id, an unknown phase -- is dropped rather than
      // falling through to a read that would buy the same thing more slowly.
      if (type.startsWith("session.reasoning.") || type.startsWith("session.text.")) {
        const streamed = this.streamedPart(type, event);
        if (streamed && sessionId && this.router.hasSession(sessionId)) {
          this.router.streamPart(sessionId, streamed);
        }
        return;
      }
    }
    switch (event.type) {
      case "session.status": {
        const status = event.data.status.type;
        if (sessionId) this.router.setRunState(sessionId, status === "idle" ? "idle" : "running");
        if (sessionId) this.router.refresh(sessionId);
        return;
      }
      case "session.idle": {
        if (sessionId) this.router.setRunState(sessionId, "idle");
        if (sessionId) this.router.refresh(sessionId);
        return;
      }
      case "session.error": {
        if (sessionId) this.router.setRunState(sessionId, "error");
        if (sessionId) this.router.refresh(sessionId);
        return;
      }
      case "session.created":
      case "session.deleted":
      case "session.updated": {
        this.router.catalogChanged();
        return;
      }
      case "permission.v2.asked": {
        if (sessionId) void this.answerPermission(sessionId, event);
        return;
      }
      case "question.v2.asked": {
        if (sessionId) void this.answerQuestion(sessionId, event);
        return;
      }
      // A compaction writes no durable message until it lands -- the checkpoint is inserted on
      // `ended` -- so the summary streams through the watch beside the thread (the same notice
      // Claude compactions draw), and only the end re-reads the messages. Deltas never refresh:
      // they arrive per token and there is nothing new to read until the checkpoint exists.
      // v1 names; v2's `session.compaction.*` is dispatched above.
      case "session.next.compaction.started": {
        const started = event as CompactionStarted;
        if (sessionId && this.router.hasSession(sessionId)) {
          this.router.setRunState(sessionId, "running");
          this.router.compactionStarted(sessionId, started.data.messageID);
        }
        return;
      }
      case "session.next.compaction.delta": {
        const delta = event as CompactionDelta;
        if (sessionId && this.router.hasSession(sessionId)) {
          this.router.compactionDelta(sessionId, delta.data.messageID, delta.data.text);
        }
        return;
      }
      case "session.next.compaction.ended": {
        const ended = event as CompactionEnded;
        if (sessionId && this.router.hasSession(sessionId)) {
          this.router.compactionEnded(sessionId, ended.data.messageID);
          this.router.refresh(sessionId, true);
        }
        return;
      }
      case "session.compacted": {
        // The checkpoint landed; a notice orphaned by a dropped stream comes down with it.
        if (sessionId && this.router.hasSession(sessionId)) {
          this.router.compactionSettled(sessionId);
          this.router.refresh(sessionId, true);
        }
        return;
      }
      default: {
        if (sessionId && this.router.hasSession(sessionId)) this.router.refresh(sessionId);
      }
    }
  }

  /**
   * One event about a running turn's prose or thinking, in the shape the tail takes.
   *
   * The serve splits each part into a lifecycle -- `started`, one `delta` per chunk, `ended`
   * carrying the whole part -- and names the part by its position among parts of its own kind,
   * which is why a message with reasoning then text numbers both 0. Returns null for an event
   * of this family that carries nothing drawable, which is dropped rather than read.
   */
  private streamedPart(type: string, event: V2Event): OpencodeStreamedPart | null {
    const kind = type.startsWith("session.reasoning.") ? "reasoning" : "text";
    // The LAST dot: the family itself carries one, after `session`.
    const phase = type.slice(type.lastIndexOf(".") + 1);
    if (phase !== "started" && phase !== "delta" && phase !== "ended") return null;
    const data = (event as { data?: Record<string, unknown> }).data ?? {};
    const messageId = data["assistantMessageID"];
    const ordinal = data["ordinal"];
    if (typeof messageId !== "string" || !messageId || typeof ordinal !== "number") return null;
    const chunk = data["delta"];
    const text = data["text"];
    return {
      kind,
      phase,
      messageId,
      ordinal,
      ...(typeof chunk === "string" && chunk ? { chunk } : {}),
      ...(typeof text === "string" && text ? { text } : {}),
    };
  }

  /**
   * v2's compaction streaming, mirroring the TUI's own handling (`stream-v2.transport.ts`):
   * `started` raises the notice and marks the session running, each `delta` extends the summary
   * beside the thread (never a re-read -- deltas arrive per token and there is nothing durable
   * to read until the checkpoint exists), and `ended` takes the notice down and re-reads the
   * whole history for the landed row. The durable `compaction` message itself streams too -- it
   * sits at `status: running` while the summary is written -- but the feed draws no banner for
   * that: the notice IS the running state, and the banner is what landing earns.
   */
  private routeCompactionV2(type: string, event: V2Event, sessionId: string | null): void {
    if (!sessionId || !this.router.hasSession(sessionId)) return;
    const data = (event as { data?: Record<string, unknown> }).data ?? {};
    switch (type) {
      case "session.compaction.started": {
        const inputID = data["inputID"];
        const eventID = (event as { id?: unknown }).id;
        const key = typeof inputID === "string" && inputID
          ? inputID
          : typeof eventID === "string" && eventID
            ? eventID
            : `v2:${sessionId}:${Date.now()}`;
        this.router.setRunState(sessionId, "running");
        this.router.compactionStarted(sessionId, key);
        return;
      }
      case "session.compaction.delta": {
        const text = data["text"];
        if (typeof text === "string" && text) this.router.compactionDeltaForSession(sessionId, text);
        return;
      }
      case "session.compaction.ended":
      case "session.compaction.failed": {
        this.router.compactionSettled(sessionId);
        this.router.refresh(sessionId, type === "session.compaction.ended");
        return;
      }
      default:
        return;
    }
  }

  /**
   * A serve permission becomes a broker select, and the reader's answer becomes
   * the serve reply. A reader that never answers resolves undefined on the
   * broker timeout, and the turn is rejected rather than left hanging: a stuck
   * permission blocks the session forever, a rejected one keeps it moving.
   */
  private async answerPermission(sessionId: string, event: PermissionAsked): Promise<void> {
    const ui = this.router.uiFor(sessionId);
    const client = this.serve();
    if (!ui || !client) return;
    const key = `permission:${event.data.id}`;
    if (this.inflightUi.has(key)) return;
    this.inflightUi.add(key);
    try {
      const answer = await ui.request({
        kind: "select",
        title: `Allow ${event.data.action}?`,
        message: event.data.resources.join("\n"),
        options: ["once", "always", "reject"],
        key,
      });
      const reply = answer === "always" ? "always" : answer === "once" ? "once" : "reject";
      const replied = await client.v2.session.permission.reply({ sessionID: sessionId, requestID: event.data.id, reply });
      if (replied.error) throw new Error(`permission reply: ${describeServeError(replied.error)}`);
    } catch (error) {
      console.error("opencode permission reply failed", { sessionId, error: String(error) });
    } finally {
      this.inflightUi.delete(key);
    }
  }

  private async answerQuestion(sessionId: string, event: QuestionAsked): Promise<void> {
    const ui = this.router.uiFor(sessionId);
    const client = this.serve();
    if (!ui || !client) return;
    const key = `question:${event.data.id}`;
    if (this.inflightUi.has(key)) return;
    this.inflightUi.add(key);
    try {
      const answers: string[][] = [];
      for (const question of event.data.questions) {
        const answer = await ui.request({
          kind: "select",
          title: question.header,
          message: question.question,
          options: question.options.map((option) => option.label),
          key: `${key}:${question.header}`,
        });
        if (typeof answer === "string") answers.push([answer]);
      }
      const replied = await client.v2.session.question.reply({
        sessionID: sessionId,
        requestID: event.data.id,
        questionV2Reply: { answers },
      });
      if (replied.error) throw new Error(`question reply: ${describeServeError(replied.error)}`);
    } catch (error) {
      console.error("opencode question reply failed", { sessionId, error: String(error) });
    } finally {
      this.inflightUi.delete(key);
    }
  }
}

function serveEventSession(event: V2Event): string | null {
  const data = (event as { data?: { sessionID?: unknown } }).data;
  return typeof data?.sessionID === "string" ? data.sessionID : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
