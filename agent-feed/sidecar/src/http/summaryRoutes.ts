// `POST /api/sessions/<source>/<id>/summary` -- one turn, digested on demand.
//
// Synchronous rather than streamed. A digest is one artifact that is either finished or not,
// and there is nothing useful to render from half of it; the panel shows a spinner and gets a
// result or an error. If this later grows a live mode, that mode gets a stream and this stays.
//
// Ordering note, the same one the timeline and task routes carry: this must be registered
// BEFORE `createSessionRoutes`, whose catch-all rejects unknown `/api/sessions/` paths.

import type { AgentRunState, SummaryResult } from "@agentdesk/agent-feed-wire";
import type { AgentBackend } from "../agents/agentBackend.ts";
import { config } from "../config.ts";
import {
  createSummaryRunner,
  SummaryUnconfiguredError,
  type SummaryRunner,
} from "../summary/summaryRuntime.ts";
import { resolveTurnWindow, type PageReader } from "../summary/turnWindow.ts";
import {
  findSession,
  getWatcherState,
  summarizeSession,
  type AgentSessionDescriptorResolver,
} from "../transcripts/transcriptCatalog.ts";
import type { SourceId, TranscriptSourceId } from "../transcripts/sources/transcriptTypes.ts";
import { jsonResponse } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";
import { readTranscriptPage } from "./sessionRoutes.ts";

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

export function createSummaryRoutes(
  resolveBackend: (id: string) => AgentBackend | undefined,
  resolveAgentSession: AgentSessionDescriptorResolver,
  runner: SummaryRunner = createSummaryRunner(),
): RouteHandler {
  // Keyed by session, not by session-and-window: a second press while the first is still
  // thinking should join that run rather than start a competing one.
  const inFlight = new Map<string, Promise<SummaryResult>>();
  // Keyed by session, holding the window it was computed over. Pressing again with nothing new
  // in the transcript is free; pressing again after the agent has spoken re-runs.
  const cache = new Map<string, CacheEntry>();

  return (request, url, server) => {
    if (request.method !== "POST") return undefined;
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

    // Bun closes an idle request after 10 seconds, which every summary exceeds. Disabled here
    // rather than raised, because the deadline already has an owner: `summaryTimeoutMs` bounds
    // the run, and Bun's own cap (255s) is below what that setting allows. One deadline, one
    // place to change it. The SSE helper disables it the same way for the same reason.
    server.timeout(request, 0);

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

    const existing = inFlight.get(key);
    if (existing) return existing.then(jsonResponse, (error: unknown) => failure(error));

    const work = summarize({
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
    });
    inFlight.set(key, work);
    void work.catch(() => {}).finally(() => inFlight.delete(key));
    return work.then(jsonResponse, (error: unknown) => failure(error));
  };
}

async function summarize(options: {
  runner: SummaryRunner;
  project: string;
  readPage: PageReader;
  runState: AgentRunState;
  cache: Map<string, CacheEntry>;
  key: string;
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

function failure(error: unknown): Response {
  if (error instanceof SummaryUnconfiguredError) {
    return errorResponse("summary-unconfigured", error.message, 503);
  }
  if (error instanceof EmptySessionError) {
    return errorResponse("session-empty", error.message, 404);
  }
  const message = error instanceof Error ? error.message : String(error);
  // Retryable: the failures this reports are a model that timed out, refused, or answered
  // unparseably, and pressing the button again is a reasonable response to all three.
  return errorResponse("summary-failed", message, 502, true);
}

function errorResponse(code: string, message: string, status: number, retryable = false): Response {
  return jsonResponse({ error: { code, message, retryable } }, status);
}
