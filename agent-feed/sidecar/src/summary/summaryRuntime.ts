// The second model: a Pi session that reads one turn and writes a digest of it.
//
// Three things make it different from the Pi sessions `piAgentBackend` owns, and all three are
// deliberate:
//
//   1. It is NOT catalogued. `SessionManager.inMemory` leaves no transcript on disk, so the
//      summarizer never appears in the sidebar and the panel never ends up observing the thing
//      that is observing it.
//   2. It has NO TOOLS AT ALL. It cannot open a file, run a command, or search the project; the
//      whole turn is handed to it in one prompt and it answers in one call. It used to have
//      read-only tools and instructions to verify the agent's claims against the checkout, and
//      that version was too slow to press -- a minute of round trips re-reading what the
//      transcript had already said. Removing them is what made it fast, and it also makes the
//      security argument trivial rather than careful: the input is transcript text an attacker
//      can shape, and there is now nothing for shaped text to reach.
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
import type {
  SummaryPhase,
  SummaryResult,
  SummaryStreamMessage,
} from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import type { AgentRunState } from "@agentdesk/agent-feed-wire";
import {
  buildSummaryPrompt,
  composeSummaryResult,
  parseSummaryPayload,
} from "@/summary/summaryPrompt";
import type { TurnWindow } from "@/summary/turnWindow";

/**
 * No tools. Not a short list -- an empty one.
 *
 * Asserted against Pi rather than assumed, because Pi's default for a session is
 * read/bash/edit/write: a summarizer that silently regained `bash` would be a remote-execution
 * path fed by attacker-shaped transcript text, and the difference between that and this is one
 * option being honoured.
 */
export const SUMMARY_TOOLS: readonly string[] = [];

/**
 * How much of one reasoning block is kept.
 *
 * A reasoning model's block runs to thousands of tokens and the panel shows it under a
 * disclosure, so the whole thing would be paid for on every transport and read by nobody. The
 * opening of a block is the part that says what it decided to do next, which is the part worth
 * keeping.
 */
const THINKING_CHARS = 2_000;

/**
 * How much reasoning accumulates before it is sent.
 *
 * Pi emits one event per token. Measured on a real run: 4,450 characters of reasoning arrived as
 * 918 events, and forwarding each one meant 918 wire messages and 918 React updates over a
 * transcript-sized tree. The panel stopped repainting part-way through and the run finished with
 * the viewer still looking at half of it.
 *
 * Coalescing by size rather than on a timer keeps this deterministic and needs no cleanup: the
 * buffer is flushed by the next event of any other kind and again when the run ends, so the tail
 * of a thought is never held back waiting for a threshold it will not reach. About a sentence at
 * a time, which is what reads as live anyway -- a single word appearing is not more informative,
 * it is just more expensive.
 */
const DELTA_FLUSH_CHARS = 200;

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
  /**
   * Present on `message_update`. Reasoning arrives as `thinking_delta` events carrying `delta`,
   * then one `thinking_end` carrying the assembled block as `content`. The two field names are
   * Pi's, and they are NOT the same one -- reading `content` off a delta silently yields nothing
   * at all, which is what it did here until a live run showed a stream with no reasoning in it.
   */
  assistantMessageEvent?: { type?: string; content?: unknown; delta?: unknown };
}

/**
 * The slice of a Pi session this module uses.
 *
 * Narrow on purpose: it is the seam a test replaces with a scripted model, and every method on
 * it is one this file actually calls.
 */
export interface SummarySession {
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
  /**
   * Called as the run happens, for a viewer watching it. Optional because the digest does not
   * depend on anyone listening: the same reasoning is on the returned result either way, so a
   * caller that only wants the artifact passes nothing and loses nothing.
   */
  onMessage?: (message: SummaryStreamMessage) => void;
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
        filesTouched: input.window.filesTouched,
        truncated: input.window.coverage.truncated,
      });

      // Everything the run says, recorded and forwarded as it happens. With no tools there is
      // one kind of event worth watching -- the model's reasoning as it reads the turn -- and it
      // is the only evidence a viewer has for whether the digest was arrived at or guessed.
      const reasoning: string[] = [];
      const emit = input.onMessage ?? (() => {});
      // How much of the thought in progress has already gone out as deltas, so the live text and
      // the block that replaces it are cut at the same place. Without this a viewer would watch
      // a long thought stream past the cap and then visibly shrink when it settled.
      let deltaChars = 0;
      let buffered = "";
      const flush = (): void => {
        if (!buffered) return;
        emit({ type: "thinking-delta", text: buffered });
        buffered = "";
      };
      const unsubscribe = session.subscribe((event) => {
        if (event.type !== "message_update") return;
        const inner = event.assistantMessageEvent;
        if (inner?.type === "thinking_delta" && typeof inner.delta === "string") {
          const room = THINKING_CHARS - deltaChars;
          if (room > 0 && inner.delta) {
            const text = inner.delta.slice(0, room);
            deltaChars += text.length;
            buffered += text;
            if (buffered.length >= DELTA_FLUSH_CHARS) flush();
          }
          return;
        }
        if (inner?.type === "thinking_end" && typeof inner.content === "string") {
          deltaChars = 0;
          buffered = "";
          const text = clamp(inner.content.trim(), THINKING_CHARS);
          if (text) {
            reasoning.push(text);
            emit({ type: "reasoning", text });
          }
        }
      });

      try {
        await withTimeout(session.prompt(prompt), config.summaryTimeoutMs, () => session.abort());
      } finally {
        unsubscribe();
        // A run that stopped mid-thought -- aborted, timed out, or simply ended without a
        // closing block -- still owes the viewer the reasoning it already produced.
        flush();
      }

      const reply = session.lastAssistantText();
      if (reply === null) throw new Error("summarizer produced no reply");

      return composeSummaryResult({
        payload: parseSummaryPayload(reply),
        reasoning,
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
