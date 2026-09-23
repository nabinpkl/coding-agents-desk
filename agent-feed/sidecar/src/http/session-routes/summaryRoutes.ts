// `GET /api/sessions/<source>/<id>/summary` -- one turn, digested on demand, streamed.
//
// This was a synchronous POST, on the reasoning that a digest is one artifact that is either
// finished or not. That was wrong in practice: the artifact takes ten to twenty seconds, and for
// all of them the panel showed a spinner that was indistinguishable from a hang. What the second
// model reasons on the way is worth watching, so the wait now shows the work.
//
// A GET because that is what a stream can be: `EventSource` cannot POST, and the relay's own
// subscribe path is GET-only, so a streamed endpoint has no other shape available. It is not a
// pure read -- it spends model tokens -- which is why one run is shared by every viewer of the
// same session rather than started once per open.
//
// Ordering note, the same one the timeline and task routes carry: this must be registered
// BEFORE `createSessionRoutes`, whose catch-all rejects unknown `/api/sessions/` paths.

import type {
  AgentRunState,
  SummaryResult,
  SummaryStreamMessage,
} from "@agentdesk/agent-feed-wire";
import type { AgentBackend } from "@/agents/agentBackend";
import { config } from "@/config/config";
import {
  createSummaryRunner,
  SummaryUnconfiguredError,
  type SummaryRunner,
} from "@/summary/summaryRuntime";
import { resolveTurnWindow, type PageReader } from "@/summary/turnWindow";
import {
  findSession,
  getWatcherState,
  summarizeSession,
  type AgentSessionDescriptorResolver,
} from "@/transcripts/catalog/transcriptCatalog";
import type { SourceId, TranscriptSourceId } from "@/transcripts/transcriptTypes";
import {
  encodeServerSentEvent,
  jsonResponse,
  startServerSentEventStream,
} from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";
import { readTranscriptPage } from "@/http/session-routes/sessionRoutes";

const SUMMARY_ROUTE =
  /^\/api\/sessions\/([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})\/summary$/;

/**
 * The digest is always taken over the `nice` view.
 *
 * Not a caller choice, unlike every other event-index endpoint. `raw` is the fidelity guarantee
 * for a human reading the transcript; for a summarizer it is thousands of `token_count` records
 * and encrypted reasoning blobs spending context to say nothing (ADR-0086).
 */
const SUMMARY_MODE = "nice" as const;

/** Same test the timeline route uses: only these two sources are durable on disk. */
function transcriptSource(source: string): TranscriptSourceId | null {
  return source === "claude" || source === "codex" ? source : null;
}

interface CacheEntry {
  toEventIndex: number;
  result: SummaryResult;
}

/**
 * One run, and everyone watching it.
 *
 * A second viewer -- the phone beside the Mac, or the same person pressing twice -- joins the
 * run in progress instead of starting a competing one, and is replayed what it has already said
 * so it does not open onto a blank panel mid-run.
 */
interface ActiveRun {
  history: SummaryStreamMessage[];
  listeners: Set<(message: SummaryStreamMessage) => void>;
  done: Promise<SummaryResult>;
}

export function createSummaryRoutes(
  resolveBackend: (id: string) => AgentBackend | undefined,
  resolveAgentSession: AgentSessionDescriptorResolver,
  runner: SummaryRunner = createSummaryRunner(),
): RouteHandler {
  // Keyed by session, not by session-and-window: a second viewer while the first is still
  // watching joins that run rather than starting a competing one.
  const active = new Map<string, ActiveRun>();
  // Keyed by session, holding the window it was computed over. Asking again with nothing new
  // in the transcript is free; asking again after the agent has spoken re-runs.
  const cache = new Map<string, CacheEntry>();

  return (request, url, server) => {
    if (request.method !== "GET") return undefined;
    const match = SUMMARY_ROUTE.exec(url.pathname);
    if (!match) return undefined;

    if (!config.summaryEnabled) {
      return errorResponse(
        "summary-unconfigured",
        "the turn summarizer has no model credential; set AGENT_FEED_SUMMARY_API_KEY",
        503,
      );
    }
    if (getWatcherState() !== "live") {
      return errorResponse("inventory-not-ready", "session inventory is still starting", 503);
    }

    const source = match[1]! as SourceId;
    const sessionId = match[2]!;
    const key = `${source}/${sessionId}`;

    const adapter = transcriptSource(source);
    const transcript = adapter && findSession(adapter, sessionId) ? adapter : null;
    const backend = resolveBackend(source);
    if (!transcript && !backend) {
      return errorResponse("session-not-found", `no session ${source}/${sessionId}`, 404);
    }

    const descriptor = resolveAgentSession(source, sessionId);
    const record = transcript ? findSession(transcript, sessionId) : undefined;
    const project = record?.project ?? descriptor?.projectPath;
    if (!project) {
      return errorResponse("session-not-found", `no project for ${source}/${sessionId}`, 404);
    }

    // The same `Bin` the sidebar shows, from the same function, rather than the backend
    // descriptor alone. A Claude session that no live backend is observing still has a turn
    // state -- the catalog derives it from transcript recency and `lastTurnClosed` -- and
    // reading only the descriptor reported every such session as finished, which is exactly
    // the case this button exists for: pressing it while the agent is still working.
    const activity = record
      ? summarizeSession(record, resolveAgentSession).activity
      : descriptor?.activity;

    // The stream is opened before the run is joined or started, so that everything from here on
    // -- including a window that turns out to be empty -- is reported inside it. A reader that
    // got a 200 and then a silent close would have no way to tell success from failure.
    return startServerSentEventStream(request, server, (write, close) => {
      const send = (message: SummaryStreamMessage): void => write(encodeServerSentEvent(message));

      const run = active.get(key) ?? startRun({
        runner,
        project,
        // A durable transcript answers for the events even when a live backend also knows this
        // session, matching how the timeline route arbitrates.
        readPage: pageReader(transcript, backend, sessionId),
        // `Bin` is coarser than `AgentRunState`, and coarser is enough: the digest only needs to
        // know whether the turn is still moving, not how it ended.
        runState: activity === "live" ? "running" : "idle",
        cache,
        key,
        active,
      });

      for (const message of run.history) send(message);
      run.listeners.add(send);

      // Every stream ends itself. The run outlives this reader only if another one is still
      // attached, and an `EventSource` that is not closed by an ended stream reopens it -- which
      // for this endpoint would mean paying for another digest.
      void run.done.then(
        (result) => {
          send({ type: "result", result });
          close();
        },
        (error: unknown) => {
          send({ type: "error", error: describeFailure(error) });
          close();
        },
      );

      return () => run.listeners.delete(send);
    });
  };
}

/**
 * Starts one run and registers it, so later viewers join rather than duplicate it.
 *
 * Everything the run says is kept in `history` as well as broadcast, because the two readers
 * this serves are not simultaneous: the Mac may be watching from the first token and the phone
 * may open halfway through, and both should see the same run.
 */
function startRun(options: {
  runner: SummaryRunner;
  project: string;
  readPage: PageReader;
  runState: AgentRunState;
  cache: Map<string, CacheEntry>;
  key: string;
  active: Map<string, ActiveRun>;
}): ActiveRun {
  const run: ActiveRun = {
    history: [],
    listeners: new Set(),
    done: undefined as unknown as Promise<SummaryResult>,
  };
  const broadcast = (message: SummaryStreamMessage): void => {
    run.history.push(message);
    for (const listener of run.listeners) listener(message);
  };
  run.done = summarize({ ...options, onMessage: broadcast });
  options.active.set(options.key, run);
  void run.done.catch(() => {}).finally(() => options.active.delete(options.key));
  return run;
}

async function summarize(options: {
  runner: SummaryRunner;
  project: string;
  readPage: PageReader;
  runState: AgentRunState;
  cache: Map<string, CacheEntry>;
  key: string;
  onMessage: (message: SummaryStreamMessage) => void;
}): Promise<SummaryResult> {
  const window = await resolveTurnWindow({
    project: options.project,
    mode: SUMMARY_MODE,
    readPage: options.readPage,
    tokenCeiling: config.summaryTokenCeiling,
  });
  if (!window) throw new EmptySessionError(`session ${options.key} has no events to summarize`);

  const cached = options.cache.get(options.key);
  // A running turn is never served from cache: its whole point is "what is happening NOW", and
  // the event index can sit still for a minute while a build runs.
  if (cached && options.runState !== "running" && cached.toEventIndex === window.coverage.toEventIndex) {
    return cached.result;
  }

  const result = await options.runner.run({
    project: options.project,
    window,
    runState: options.runState,
    onMessage: options.onMessage,
  });
  options.cache.set(options.key, { toEventIndex: window.coverage.toEventIndex, result });
  return result;
}

/** Reads pages from whichever holds this session's durable record. */
function pageReader(
  transcript: TranscriptSourceId | null,
  backend: AgentBackend | undefined,
  sessionId: string,
): PageReader {
  if (transcript) {
    return async (offset, limit) => {
      const page = await readTranscriptPage(transcript, sessionId, offset, limit, SUMMARY_MODE);
      return page ? { events: page.events, total: page.total } : null;
    };
  }
  const owner = backend!;
  return async (offset, limit) => {
    const page = await owner.page(sessionId, offset, limit, SUMMARY_MODE);
    return { events: page.events, total: page.total };
  };
}

/** A session with no events at all, which is a 404 rather than a failed summary. */
class EmptySessionError extends Error {}

/**
 * A failed run, as a coded error.
 *
 * These reach the panel inside the stream rather than as a status, because by the time the run
 * can fail the response has already been committed as a 200 event-stream. Same codes either
 * way: what went wrong does not depend on how far the request had got.
 */
function describeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof SummaryUnconfiguredError) {
    return { code: "summary-unconfigured", message: error.message, retryable: false };
  }
  if (error instanceof EmptySessionError) {
    return { code: "session-empty", message: error.message, retryable: false };
  }
  // Retryable: the failures this reports are a model that timed out, refused, or answered
  // unparseably, and asking again is a reasonable response to all three.
  return {
    code: "summary-failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function errorResponse(code: string, message: string, status: number, retryable = false): Response {
  return jsonResponse({ error: { code, message, retryable } }, status);
}
