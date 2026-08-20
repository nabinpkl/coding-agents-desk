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
import type { SummaryPhase, SummaryResult } from "@agentdesk/agent-feed-wire";
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

/** Raised when the feature has no credential. Distinct from a run that failed, because the
 *  route answers 503 for one and 502 for the other. */
export class SummaryUnconfiguredError extends Error {}

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
  subscribe(listener: (event: { type: string }) => void): () => void;
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
      let toolCalls = 0;
      let overBudget = false;
      const unsubscribe = session.subscribe((event) => {
        if (event.type !== "tool_execution_start") return;
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
