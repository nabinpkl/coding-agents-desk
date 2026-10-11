// The arena tab's data: the status stream, and the three requests a run is made, read and
// torn down with.
//
// Everything crossing this boundary is validated rather than cast. The stream is the sidecar
// pushing state the page never asked to receive, and a hand-edited or stale answer must fall
// back to "no runs yet" rather than reshape the panel around a shape that is not there --
// which is what a cast would do.
//
// One thing this module deliberately does not do is deep-link a contestant's session. The arena
// records that a contestant is a session; where a reader opens one is the session surface's
// existing business (the canvas roster's modal), and a link invented here would be a second
// path to it.

import type {
  ArenaContestantSource,
  ArenaContestantDetail,
  ArenaRunDetail,
  ArenaRunSummary,
} from "@agentdesk/agent-feed-wire";
import type { AgentHttpTransport } from "@/features/activity-feed/transport/AgentHttpTransport";

const RUNS_PATH = "/api/arena/runs";
const STREAM_PATH = "/api/arena/runs/stream";

function contestantSummaryOf(value: unknown): ArenaRunSummary["contestants"][number] | null {
  if (!value || typeof value !== "object") return null;
  const c = value as Record<string, unknown>;
  if (typeof c.contestantId !== "string" || typeof c.worktreePath !== "string") return null;
  if (c.status !== "preparing" && c.status !== "running" && c.status !== "closed" && c.status !== "failed") {
    return null;
  }
  if (c.source !== "opencode" && c.source !== "claude") return null;
  return {
    contestantId: c.contestantId,
    source: c.source,
    sessionId: typeof c.sessionId === "string" ? c.sessionId : null,
    worktreePath: c.worktreePath,
    status: c.status,
    startedAt: typeof c.startedAt === "number" ? c.startedAt : null,
    closedAt: typeof c.closedAt === "number" ? c.closedAt : null,
    durationMs: typeof c.durationMs === "number" ? c.durationMs : null,
    error: typeof c.error === "string" ? c.error : null,
  };
}

export function parseRunSummary(value: unknown): ArenaRunSummary | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Record<string, unknown>;
  if (typeof run.runId !== "string" || typeof run.prompt !== "string") return null;
  if (typeof run.repoPath !== "string" || typeof run.baseRef !== "string") return null;
  if (typeof run.createdAt !== "number" || !Array.isArray(run.contestants)) return null;
  const contestants = run.contestants.map(contestantSummaryOf);
  if (contestants.some((one) => one === null)) return null;
  return {
    runId: run.runId,
    prompt: run.prompt,
    repoPath: run.repoPath,
    baseRef: run.baseRef,
    createdAt: run.createdAt,
    contestants: contestants as ArenaRunSummary["contestants"],
  };
}

/** One stream frame's worth of runs, or null when the frame is not one. */
export function parseRunsStreamFrame(payload: string): ArenaRunSummary[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const frame = parsed as Record<string, unknown>;
  if (frame.type !== "runs" || !Array.isArray(frame.runs)) return null;
  const runs = frame.runs.map(parseRunSummary);
  return runs.some((one) => one === null) ? null : (runs as ArenaRunSummary[]);
}

export function parseRunDetail(value: unknown): ArenaRunDetail | null {
  const summary = parseRunSummary(value);
  if (!summary) return null;
  const run = value as Record<string, unknown>;
  const contestants = (run.contestants as unknown[]).map((raw) => {
    const c = raw as Record<string, unknown>;
    const detail: ArenaContestantDetail = {
      ...(contestantSummaryOf(raw) as ArenaContestantDetail),
      contextTokens: typeof c.contextTokens === "number" ? c.contextTokens : null,
      costUsd: typeof c.costUsd === "number" ? c.costUsd : null,
      filesRead: stringArrayOf(c.filesRead),
      filesWritten: stringArrayOf(c.filesWritten),
      gitDiff: typeof c.gitDiff === "string" ? c.gitDiff : null,
    };
    return detail;
  });
  return { ...summary, contestants };
}

function stringArrayOf(value: unknown): string[] {
  return Array.isArray(value) && value.every((one) => typeof one === "string") ? [...value] : [];
}

/** The message inside a sidecar failure envelope, or a plain fallback when there is none. */
function failureMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") return parsed.error.message;
  } catch {
    // fall through to the status
  }
  return `the sidecar answered ${status}`;
}

export async function fetchArenaRuns(transport: AgentHttpTransport): Promise<ArenaRunSummary[]> {
  const response = await transport.request("GET", RUNS_PATH);
  if (response.status !== 200) return [];
  try {
    const parsed = JSON.parse(response.body) as { runs?: unknown };
    if (!Array.isArray(parsed.runs)) return [];
    const runs = parsed.runs.map(parseRunSummary);
    return runs.some((one) => one === null) ? [] : (runs as ArenaRunSummary[]);
  } catch {
    return [];
  }
}

export async function fetchArenaRunDetail(
  transport: AgentHttpTransport,
  runId: string,
): Promise<ArenaRunDetail | null> {
  const response = await transport.request("GET", `${RUNS_PATH}/${runId}`);
  if (response.status !== 200) return null;
  try {
    return parseRunDetail(JSON.parse(response.body));
  } catch {
    return null;
  }
}

/** Creates a run. The failure carries the sidecar's own message, which names what was wrong. */
export async function createArenaRun(
  transport: AgentHttpTransport,
  request: { prompt: string; repoPath: string; contestants: readonly ArenaContestantSource[] },
): Promise<{ run: ArenaRunSummary } | { message: string }> {
  const response = await transport.request("POST", RUNS_PATH, {
    body: {
      prompt: request.prompt,
      repoPath: request.repoPath,
      contestants: request.contestants.map((source) => ({ source })),
    },
  });
  if (response.status !== 201) return { message: failureMessage(response.body, response.status) };
  try {
    const run = parseRunSummary(JSON.parse(response.body));
    return run ? { run } : { message: "the sidecar answered with a run this panel could not read" };
  } catch {
    return { message: "the sidecar answered with a run this panel could not read" };
  }
}

/** Tears a finished run down; a busy run answers 409 and keeps its own message. */
export async function deleteArenaRun(
  transport: AgentHttpTransport,
  runId: string,
): Promise<{ deleted: true } | { message: string }> {
  const response = await transport.request("DELETE", `${RUNS_PATH}/${runId}`);
  if (response.status !== 200) return { message: failureMessage(response.body, response.status) };
  return { deleted: true };
}

export { RUNS_PATH, STREAM_PATH };