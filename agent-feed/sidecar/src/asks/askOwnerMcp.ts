// The ask_owner tool, served to one Claude session over MCP by the `ask-owner` mod.
//
// A call is sent to the sidecar (`POST /api/asks`) and held there until the owner answers it in the
// panel, and the answers are this tool's result. Everything that can go wrong in between is retried
// HERE, in this process, and never handed back to the model as a quick failure: a tool that came
// back at once with "sidecar unreachable" would invite the model to call it again at once, a turn
// of model calls per second for as long as the sidecar was down. So the tool returns quickly in one
// case only, questions the sidecar refused as malformed, and otherwise returns when the owner has
// answered or dismissed, or when Claude cancels the call.
//
// The other loops this guards against:
// - Asking again. The description and the dismissed result both tell the model not to ask the same
//   questions again, and a call moved to the background after two minutes is still waiting here,
//   so asking a second time would only put a second card in front of the owner.
// - Retrying a sidecar that answers and hangs up at once. Every attempt that ends without a verdict
//   waits longer before the next (`RETRY_MS`), so a sidecar caught in a restart is asked a few
//   times a minute rather than continuously.
// - Malformed questions, refused again and again. That is the one quick return, so after a few in a
//   row the result tells the model to stop calling this tool and ask in plain text.
// - Outliving the session. Claude Code closes this process's input when the session ends, and
//   `askOwnerMcpMain.ts` exits on that; a cancelled call aborts its request.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AskOwnerAnswer, AskOwnerCall, AskOwnerVerdict, WaitAskOwnerCommand } from "@agentdesk/agent-feed-wire";

/** The mod, its server and its tool, as Claude Code names a mod's tool. */
export const ASK_OWNER_MOD = "ask-owner";
export const ASK_OWNER_SERVER = "ask";
export const ASK_OWNER_TOOL = "ask_owner";
export const ASK_OWNER_TOOL_NAME = `mcp__plugin_${ASK_OWNER_MOD}_${ASK_OWNER_SERVER}__${ASK_OWNER_TOOL}`;

/** The waits between attempts that end without a verdict, the last repeating. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
/** A wait that hears nothing for this long, not even the sidecar's 20-second heartbeat, is redone. */
const STALL_MS = 60_000;
/** Refusals in a row after which the tool tells the model to stop using it. */
const REFUSALS_BEFORE_STOP = 3;

const DESCRIPTION = [
  "Ask the owner, the owner, up to five questions and wait for the answers.",
  "Use this ONLY when the owner, or the brief you were given, tells you to ask the owner or to use ask_owner;",
  "otherwise ask with AskUserQuestion as usual.",
  'Each question is answered by picking one option ("single"), any of them ("multi"), or in words',
  '("text", which has no options). An option can carry a description, a preformatted preview, and a',
  'noteLabel such as "Why?" that invites a note on it. the owner can always add a note or answer in words.',
  "the owner answers when they see it, which can take a long time. If the call moves to the background,",
  "stop and wait for its result. Never call ask_owner again while one is waiting, and do not ask the",
  "same questions again after the owner closes them without answering.",
].join(" ");

const OPTION = z.object({
  label: z.string().describe("What the option says. Unique within its question."),
  description: z.string().optional(),
  preview: z.string().optional().describe("A small diagram or snippet, shown preformatted."),
  noteLabel: z.string().optional().describe('Invites a note on this option if chosen, such as "Why?".'),
});

const QUESTION = z.object({
  id: z.string().describe("The key this question's answer comes back under. Unique within the call."),
  question: z.string(),
  header: z.string().optional().describe("A label of a word or two for the question's tab."),
  kind: z.enum(["single", "multi", "text"]),
  options: z.array(OPTION).default([]).describe('2 to 8 options; none for a "text" question.'),
  placeholder: z.string().optional().describe("What the answer field shows while empty."),
});

/** What the tool needs from the world, injected so the waiting is tested without a sidecar. */
export interface AskOwnerDependencies {
  /** The session this process serves, or why there is none. Read per call: `/clear` changes it. */
  session: () => { source: "claude"; sessionId: string } | string;
  /** Sends the call to the sidecar; the response streams until the verdict. */
  post: (command: WaitAskOwnerCommand, signal: AbortSignal) => Promise<Response>;
  /** Waits `ms`, or less if `signal` aborts. */
  pause: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
}

export type WaitOutcome = AskOwnerVerdict | { refused: string } | { cancelled: true };

/**
 * Holds the call at the sidecar until it has a verdict, sending it again after every connection
 * that ends without one. Returns early only for a refusal or a cancelled call.
 */
export async function waitForVerdict(
  command: WaitAskOwnerCommand,
  deps: AskOwnerDependencies,
  signal: AbortSignal,
  stallMs: number = STALL_MS,
): Promise<WaitOutcome> {
  let failures = 0;
  while (!signal.aborted) {
    const attempt = new AbortController();
    const abort = () => attempt.abort();
    signal.addEventListener("abort", abort, { once: true });
    let stall: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      clearTimeout(stall);
      stall = setTimeout(abort, stallMs);
    };
    try {
      heard();
      const response = await deps.post(command, attempt.signal);
      if (response.status === 400) return { refused: await refusal(response) };
      if (response.ok && response.body) {
        const verdict = await readVerdict(response.body, heard);
        if (verdict) return verdict;
      } else {
        deps.log?.(`ask_owner: the sidecar answered ${response.status}; asking again`);
      }
    } catch (error) {
      if (signal.aborted) break;
      deps.log?.(`ask_owner: ${(error as Error).message}; asking again`);
    } finally {
      clearTimeout(stall);
      signal.removeEventListener("abort", abort);
    }
    if (signal.aborted) break;
    await deps.pause(RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!, signal);
    failures += 1;
  }
  return { cancelled: true };
}

async function refusal(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? "the questions were refused";
  } catch {
    return "the questions were refused";
  }
}

/** The first verdict a stream carries, or null when it ends without one. */
async function readVerdict(body: ReadableStream<Uint8Array>, heard: () => void): Promise<AskOwnerVerdict | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    heard();
    buffered += decoder.decode(value, { stream: true });
    const frames = buffered.split("\n\n");
    buffered = frames.pop() ?? "";
    for (const frame of frames) {
      if (!frame.startsWith("data: ")) continue;
      const parsed = JSON.parse(frame.slice("data: ".length)) as AskOwnerVerdict;
      if ("answered" in parsed || "dismissed" in parsed) {
        await reader.cancel();
        return parsed;
      }
    }
  }
}

/** The answers as the model reads them: each question, then what the owner said. */
export function answeredText(questions: AskOwnerCall["questions"], answers: readonly AskOwnerAnswer[]): string {
  const lines = ["the owner answered:"];
  for (const answer of answers) {
    const asked = questions.find((each) => each.id === answer.id);
    lines.push(`- ${answer.id}: ${asked?.question ?? ""}`);
    for (const choice of answer.chosen) {
      lines.push(`  - chose "${choice.label}"${choice.note ? `, with the note: ${choice.note}` : ""}`);
    }
    if (answer.text) lines.push(`  - in their own words: ${answer.text}`);
  }
  return lines.join("\n");
}

const DISMISSED =
  "the owner closed these questions without answering. Do not ask them again on your own: carry on with " +
  "what you have, or say in your reply what you still need from the owner.";

export function createAskOwnerMcpServer(deps: AskOwnerDependencies): McpServer {
  const server = new McpServer({ name: ASK_OWNER_SERVER, version: "0.1.0" });
  let refusedInARow = 0;
  server.registerTool(
    ASK_OWNER_TOOL,
    {
      description: DESCRIPTION,
      inputSchema: { questions: z.array(QUESTION).min(1).max(5) },
    },
    async ({ questions }, extra) => {
      const failure = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
      const toolUseId = extra._meta?.["claudecode/toolUseId"];
      if (typeof toolUseId !== "string") return failure("ask_owner: this call carries no tool use id to wait under");
      const session = deps.session();
      if (typeof session === "string") return failure(`ask_owner: ${session}`);
      const command: WaitAskOwnerCommand = { toolUseId, ...session, questions };
      const outcome = await waitForVerdict(command, deps, extra.signal);
      if ("refused" in outcome) {
        refusedInARow += 1;
        if (refusedInARow >= REFUSALS_BEFORE_STOP) {
          return failure(
            `ask_owner refused these questions: ${outcome.refused}. That is ${refusedInARow} refusals in a row: ` +
              "stop calling ask_owner, and ask the owner in plain text in your reply instead.",
          );
        }
        return failure(`ask_owner refused these questions: ${outcome.refused}. Correct them before asking again.`);
      }
      refusedInARow = 0;
      if ("cancelled" in outcome) return failure("ask_owner: the call was cancelled before the owner answered");
      if ("dismissed" in outcome) return { content: [{ type: "text" as const, text: DISMISSED }] };
      return { content: [{ type: "text" as const, text: answeredText(questions, outcome.answered) }] };
    },
  );
  return server;
}
