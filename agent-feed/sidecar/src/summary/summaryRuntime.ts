// The second agent: a Pi session that reads one turn and writes a digest of it.
//
// Three things make it different from the Pi sessions `piAgentBackend` owns, and all three are
// deliberate:
//
//   1. It is NOT catalogued. `SessionManager.inMemory` leaves no transcript on disk, so the
//      summarizer never appears in the sidebar and the panel never ends up observing the thing
//      that is observing it.
//   2. Its tools are read-only. Verified rather than assumed: with this allowlist Pi reports
//      `getAllTools()` as exactly read/grep/find/ls, where the default is read/bash/edit/write.
//      Its input is a transcript full of third-party text, so a bash tool here would be a
//      remote-execution path with extra steps.
//   3. Its model is separate and cheap. Named as a provider/model pair in Pi's OWN catalog, so
//      `opencode-go/deepseek-v4-flash` arrives with its base URL, thinking format, context
//      window and cost table already correct.

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import type { SummaryPhase, SummaryResult, SummaryStep } from "@agentdesk/agent-feed-wire";
import { config } from "../config.ts";
import type { AgentRunState } from "@agentdesk/agent-feed-wire";
import {
  buildSummaryPrompt,
  composeSummaryResult,
  parseSummaryPayload,
} from "./summaryPrompt.ts";
import type { TurnWindow } from "./turnWindow.ts";

/** The read-only set. Ordered as Pi reports it, so a test can compare without sorting. */
export const SUMMARY_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * How much of one reasoning block is kept.
 *
 * A reasoning model's block runs to thousands of tokens and the panel shows it under a
 * disclosure, so the whole thing would be paid for on every transport and read by nobody. The
 * opening of a block is the part that says what it decided to do next, which is the part worth
 * keeping.
 */
const THINKING_CHARS = 2_000;

/** Enough to identify what a call was pointed at, short enough to stay one line. */
const TARGET_CHARS = 200;

/** Raised when the feature has no credential. Distinct from a run that failed, because the
 *  route answers 503 for one and 502 for the other. */
export class SummaryUnconfiguredError extends Error {}

/**
 * The fields of Pi's event union this module reads, all optional because one event carries a
 * few of them. Restated rather than imported so the test seam can emit an event by hand without
 * constructing a whole `AgentSessionEvent`.
 */
export interface SummarySessionEvent {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  isError?: boolean;
  /** Present on `message_update`. Reasoning arrives as deltas and then one `thinking_end`
   *  carrying the assembled block, which is the one worth recording. */
  assistantMessageEvent?: { type?: string; content?: unknown };
}

/**
 * The slice of a Pi session this module uses.
 *
 * Narrow on purpose: it is the seam a test replaces with a scripted model, and every method on
 * it is one this file actually calls.
 */
export interface SummarySession {
  /** What Pi says the session can do, for the assertion that the allowlist held. */
  activeToolNames(): string[];
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: SummarySessionEvent) => void): () => void;
  abort(): Promise<void>;
  /** Concatenated text of the final assistant message, or null if there was none. */
  lastAssistantText(): string | null;
}

export type SummarySessionFactory = (project: string) => Promise<SummarySession>;

export interface SummaryRunInput {
  project: string;
  window: TurnWindow;
  runState: AgentRunState;
}

export interface SummaryRunner {
  run(input: SummaryRunInput): Promise<SummaryResult>;
}

export function createSummaryRunner(
  createSession: SummarySessionFactory = createPiSummarySession,
  now: () => number = Date.now,
): SummaryRunner {
  return {
    async run(input) {
      if (!config.summaryEnabled) {
        throw new SummaryUnconfiguredError("AGENT_FEED_SUMMARY_API_KEY is not set");
      }
      const phase: SummaryPhase = input.runState === "running" ? "running" : "final";
      const session = await createSession(input.project);
      const prompt = buildSummaryPrompt({
        project: input.project,
        phase,
        events: input.window.events,
        gitBlock: input.window.gitBlock,
        truncated: input.window.coverage.truncated,
      });

      // A summarizer that reads the whole repository is a summarizer nobody will press twice.
      // The budget is enforced here rather than trusted to the prompt, the same way
      // `piAgentBackend` enforces its own.
      //
      // The same subscription records what the run did. Both readings are of the same events, so
      // a tool call that counts against the budget is by construction a tool call the viewer is
      // shown; there is no way for one to know about a call the other missed.
      let toolCalls = 0;
      let overBudget = false;
      const steps: SummaryStep[] = [];
      const stepByToolCall = new Map<string, SummaryToolStep>();
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "message_update") {
          const inner = event.assistantMessageEvent;
          if (inner?.type === "thinking_end" && typeof inner.content === "string") {
            const text = clamp(inner.content.trim(), THINKING_CHARS);
            if (text) steps.push({ kind: "thinking", text });
          }
          return;
        }
        if (event.type === "tool_execution_end") {
          const started = event.toolCallId ? stepByToolCall.get(event.toolCallId) : undefined;
          if (started && event.isError) started.failed = true;
          return;
        }
        if (event.type !== "tool_execution_start") return;
        const step: SummaryToolStep = {
          kind: "tool",
          name: event.toolName ?? "unknown",
          target: toolTarget(event.args, input.project),
          failed: false,
        };
        steps.push(step);
        if (event.toolCallId) stepByToolCall.set(event.toolCallId, step);
        toolCalls += 1;
        if (toolCalls > config.summaryToolCallBudget && !overBudget) {
          overBudget = true;
          void session.abort();
        }
      });

      try {
        await withTimeout(session.prompt(prompt), config.summaryTimeoutMs, () => session.abort());
      } finally {
        unsubscribe();
      }

      if (overBudget) {
        throw new Error(`summarizer exceeded its ${config.summaryToolCallBudget} tool-call budget`);
      }
      const reply = session.lastAssistantText();
      if (reply === null) throw new Error("summarizer produced no reply");

      return composeSummaryResult({
        payload: parseSummaryPayload(reply),
        steps,
        phase,
        model: `${config.summaryProvider}/${config.summaryModel}`,
        filesTouched: input.window.filesTouched,
        coverage: input.window.coverage,
        runState: input.runState,
        generatedAt: now(),
      });
    },
  };
}

/** The mutable half of the union, so a later `tool_execution_end` can mark it failed. */
type SummaryToolStep = Extract<SummaryStep, { kind: "tool" }>;

/**
 * What a tool call was pointed at, as one line.
 *
 * All four read-only tools take `path`, `pattern`, `glob` or some combination, so this reads
 * them by name rather than dumping the argument object: a viewer wants to see WHICH file was
 * opened, not the offset and limit it was opened with. An unrecognised shape yields an empty
 * target rather than a guess, and the tool name alone still tells the story.
 *
 * Paths inside the project are shown relative to it, matching the file list the digest already
 * renders above this one. A path OUTSIDE the project keeps its absolute form, because a
 * summarizer that went looking outside the checkout is the one case worth seeing in full.
 */
function toolTarget(args: unknown, project: string): string {
  if (typeof args !== "object" || args === null) return "";
  const read = (key: string): string => {
    const value = (args as Record<string, unknown>)[key];
    return typeof value === "string" ? value.trim() : "";
  };
  const what = [read("pattern"), read("glob")].filter(Boolean).join(" ");
  const where = relativeToProject(read("path"), project);
  const target = what && where ? `${what} in ${where}` : what || where;
  return clamp(target, TARGET_CHARS);
}

function relativeToProject(path: string, project: string): string {
  const root = project.endsWith("/") ? project : `${project}/`;
  // The project itself, named as itself rather than collapsing to nothing.
  if (path === project) return ".";
  return path.startsWith(root) ? path.slice(root.length) : path;
}

/** Truncation that says it truncated. A silently cut reasoning block reads as a model that
 *  stopped mid-thought. */
function clamp(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * Loud, not silent: a request that hangs forever is indistinguishable from a panel that never
 * sent it, and the viewer is looking at a spinner either way.
 */
async function withTimeout(work: Promise<void>, ms: number, onTimeout: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error(`summarizer did not answer within ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * One process-wide model runtime.
 *
 * Built lazily and once: `ModelRuntime.create` loads the whole provider catalog, which is a
 * fixed cost that has no business being paid per button press. `allowModelNetwork: false`
 * because the catalog we need ships with Pi and a summary request is not the moment to discover
 * that a model-list refresh is slow.
 */
let modelRuntimePromise: Promise<ModelRuntime> | null = null;

function summaryModelRuntime(): Promise<ModelRuntime> {
  modelRuntimePromise ??= (async () => {
    const credentials = new InMemoryCredentialStore();
    // In memory, never on disk, and holding exactly one provider's key. Pi's own auth.json is
    // deliberately not used: it holds every credential this machine has, and the summarizer has
    // no business being able to reach any of them but its own.
    await credentials.modify(config.summaryProvider, async () => ({
      type: "api_key",
      key: config.summaryApiKey ?? undefined,
    }));
    return ModelRuntime.create({ credentials, allowModelNetwork: false });
  })();
  return modelRuntimePromise;
}

/** Test seam reset. Only for suites that swap config out from under the module. */
export function resetSummaryModelRuntime(): void {
  modelRuntimePromise = null;
}

const createPiSummarySession: SummarySessionFactory = async (project) => {
  const modelRuntime = await summaryModelRuntime();
  const model = modelRuntime.getModel(config.summaryProvider, config.summaryModel);
  if (!model) {
    throw new Error(
      `summarizer model ${config.summaryProvider}/${config.summaryModel} is not in Pi's catalog`,
    );
  }
  const services = await createAgentSessionServices({ cwd: project, modelRuntime });
  const created = await createAgentSessionFromServices({
    services,
    // The whole reason the summarizer stays invisible. `SessionManager.create` would write a
    // transcript into Pi's sessions directory, which the catalog scans.
    sessionManager: SessionManager.inMemory(project),
    model,
    tools: [...SUMMARY_TOOLS],
  });
  const session = created.session;
  return {
    activeToolNames: () => session.getActiveToolNames(),
    prompt: (text) => session.prompt(text),
    subscribe: (listener) => session.subscribe(listener as never),
    abort: () => session.abort(),
    lastAssistantText: () => assistantText(session.messages),
  };
};

/** The final assistant message's text blocks, joined. Null when the run produced none. */
function assistantText(messages: readonly unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block): block is { type: string; text: string } =>
        typeof block === "object" && block !== null
        && (block as { type?: unknown }).type === "text"
        && typeof (block as { text?: unknown }).text === "string")
      .map((block) => block.text)
      .join("");
    if (text.trim()) return text;
  }
  return null;
}
