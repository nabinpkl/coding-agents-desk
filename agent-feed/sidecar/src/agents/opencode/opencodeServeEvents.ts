// One serve event stream for the process, fanned out per session.
//
// Shared rather than per session because the serve already multiplexes: every
// event carries its session, so N sessions cost one connection and a thread
// opened later joins whatever is already flowing. Split from the backend
// because the stream lifecycle plus permission answering is one idea and
// projections plus commands are another.

import type { V2Event } from "@opencode/client";
import { isServeUnauthorized, resetOpencodeClient, type OpencodeClient } from "@/agents/opencode/opencodeClient";
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
  /**
   * One streamed delta of a running compaction's summary. `session.compaction.delta` carries
   * only `sessionID` plus text, so it appends to whatever is newest there rather than to a
   * named flow.
   */
  compactionDeltaForSession(sessionId: string, text: string): void;
  /**
   * A running turn's prose or thinking advanced. Delivered to the projection rather than
   * re-read: the serve is publishing the words as they are written, so reading the messages
   * back would only arrive later, in steps, having re-read 200 of them to move one line.
   */
  streamPart(sessionId: string, part: OpencodeStreamedPart): void;
  /**
   * A compaction ended or failed. Neither event names the compaction, only the session, so this
   * ends whatever is running there: the notice must not outlive the row it waited on.
   */
  compactionSettled(sessionId: string): void;
}

type PermissionAsked = Extract<V2Event, { type: "permission.asked" }>;
type FormCreated = Extract<V2Event, { type: "form.created" }>;
type FormField = FormCreated["data"]["form"]["fields"][number];
type FormAnswer = string | number | boolean | readonly string[];

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
        for await (const event of client.event.subscribe({ signal: abort.signal })) {
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
    // A running turn's own words: these arrive per chunk, and every one of them used to buy a
    // re-read of the newest page. The durable read now waits for the step to end instead.
    // Recognised by the family and not by whether the event parses, so an event this shape
    // cannot draw -- no session, no message id, an unknown phase -- is dropped rather than
    // falling through to a read that would buy the same thing more slowly.
    if (event.type.startsWith("session.reasoning.") || event.type.startsWith("session.text.")) {
      const streamed = this.streamedPart(event.type, event);
      if (streamed && sessionId && this.router.hasSession(sessionId)) {
        this.router.streamPart(sessionId, streamed);
      }
      return;
    }
    if (event.type.startsWith("session.compaction.")) {
      this.routeCompaction(event, sessionId);
      return;
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
      case "session.execution.failed": {
        if (sessionId) this.router.setRunState(sessionId, "error");
        if (sessionId) this.router.refresh(sessionId);
        return;
      }
      // A model switch lands on no message, so this refresh is what picks the new name up, and
      // the pool's announce is what carries it to an open stream.
      case "session.model.selected": {
        if (sessionId && this.router.hasSession(sessionId)) this.router.refresh(sessionId);
        return;
      }
      case "session.created":
      case "session.deleted":
      case "session.renamed":
      case "session.moved": {
        this.router.catalogChanged();
        return;
      }
      case "permission.asked": {
        if (sessionId) void this.answerPermission(sessionId, event);
        return;
      }
      case "form.created": {
        void this.answerForm(event);
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
   * Compaction streaming, mirroring the TUI's own handling (`stream-v2.transport.ts`):
   * `started` raises the notice and marks the session running, each `delta` extends the summary
   * beside the thread (never a re-read -- deltas arrive per token and there is nothing durable
   * to read until the checkpoint exists), and `ended` takes the notice down and re-reads the
   * whole history for the landed row. The durable `compaction` message itself streams too -- it
   * sits at `status: running` while the summary is written -- but the feed draws no banner for
   * that: the notice IS the running state, and the banner is what landing earns.
   */
  private routeCompaction(event: V2Event, sessionId: string | null): void {
    if (!sessionId || !this.router.hasSession(sessionId)) return;
    switch (event.type) {
      case "session.compaction.started": {
        const key = event.data.inputID || event.id || `compaction:${sessionId}:${Date.now()}`;
        this.router.setRunState(sessionId, "running");
        this.router.compactionStarted(sessionId, key);
        return;
      }
      case "session.compaction.delta": {
        if (event.data.text) this.router.compactionDeltaForSession(sessionId, event.data.text);
        return;
      }
      case "session.compaction.ended":
      case "session.compaction.failed": {
        this.router.compactionSettled(sessionId);
        this.router.refresh(sessionId, event.type === "session.compaction.ended");
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
      const decision = answer === "always" ? "always" : answer === "once" ? "once" : "reject";
      await client.permission.reply({ sessionID: sessionId, requestID: event.data.id, decision });
    } catch (error) {
      console.error("opencode permission reply failed", { sessionId, error: String(error) });
    } finally {
      this.inflightUi.delete(key);
    }
  }

  /**
   * A serve form becomes one broker request per field, and the answers become its reply. The
   * broker asks one question at a time, so each field is the closest single request: a choice
   * is a select, a yes or no a confirm, anything typed an input. A field the panel cannot
   * answer -- a link to finish elsewhere -- leaves the form for the serve to time out, the way
   * a reader who never answers does.
   */
  private async answerForm(event: FormCreated): Promise<void> {
    const form = event.data.form;
    const ui = this.router.uiFor(form.sessionID);
    const client = this.serve();
    if (!ui || !client) return;
    const key = `form:${form.id}`;
    if (this.inflightUi.has(key)) return;
    this.inflightUi.add(key);
    try {
      const answer: Record<string, FormAnswer> = {};
      for (const field of form.fields) {
        if (field.type === "external" || ("hidden" in field && field.hidden)) continue;
        const value = await this.askField(ui, `${key}:${field.key}`, form.title, field);
        if (value !== undefined) answer[field.key] = value;
      }
      await client.session.form.reply({ sessionID: form.sessionID, formID: form.id, answer });
    } catch (error) {
      console.error("opencode form reply failed", { sessionId: form.sessionID, error: String(error) });
    } finally {
      this.inflightUi.delete(key);
    }
  }

  private async askField(
    ui: AgentUiBroker,
    key: string,
    formTitle: string,
    field: Exclude<FormField, { type: "external" }>,
  ): Promise<FormAnswer | undefined> {
    const title = field.title ?? formTitle;
    const message = field.description;
    switch (field.type) {
      case "boolean": {
        const answer = await ui.request({ kind: "confirm", title, message: message ?? "", key });
        return typeof answer === "boolean" ? answer : undefined;
      }
      case "multiselect":
      case "string": {
        const options = field.options?.map((option) => option.label ?? option.value) ?? [];
        if (options.length > 0) {
          const answer = await ui.request({ kind: "select", title, message, options, key });
          if (typeof answer !== "string") return undefined;
          const chosen = field.options?.find((option) => (option.label ?? option.value) === answer)?.value ?? answer;
          return field.type === "multiselect" ? [chosen] : chosen;
        }
        const answer = await ui.request({ kind: "input", title, placeholder: "placeholder" in field ? field.placeholder : undefined, key });
        return typeof answer === "string" ? answer : undefined;
      }
      case "number":
      case "integer": {
        const answer = await ui.request({ kind: "input", title, key });
        const parsed = typeof answer === "string" ? Number(answer) : Number.NaN;
        if (!Number.isFinite(parsed)) return undefined;
        return field.type === "integer" ? Math.trunc(parsed) : parsed;
      }
    }
  }
}

/** The session an event is about: most carry it on `data`, a form on the form itself. */
function serveEventSession(event: V2Event): string | null {
  const data = (event as { data?: { sessionID?: unknown; form?: { sessionID?: unknown } } }).data;
  const sessionId = data?.sessionID ?? data?.form?.sessionID;
  return typeof sessionId === "string" ? sessionId : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
