// Raw serve calls that own no session state: staging image bytes where the serve can read
// them, and listing what it offers after a slash. Both travel the raw path beside the SDK
// (see `opencodeClient.ts`) and both are pure over their arguments, which is what keeps them
// out of the backend: the backend owns sessions, the ledger and the projection, and none of
// that is needed to write a file or read a list.

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessageAttachment } from "@/agents/agentBackend";
import { resetOpencodeClient, serveGet, serveWrite } from "@/agents/opencode/opencodeClient";
import { readOpencodeTail } from "@/agents/opencode/opencodeHistory";

/** One slash command the serve offers, as the composer picker shows it. */
export interface OpencodeSlashCommand {
  name: string;
  description?: string;
}

/**
 * Where the live window starts: the newest completed compaction, TUI-identical
 * (`lastAssistantWithUsage` in `packages/tui/src/util/session.ts`). Assistants at
 * or before it belong to the context that compacting just emptied, so the anchor
 * search stays strictly after it. -1 when nothing has compacted.
 */
export function lastCompletedCompactionIndex(
  messages: readonly { type?: unknown; status?: unknown }[],
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.type === "compaction" && message.status === "completed") return i;
  }
  return -1;
}

/**
 * The live window's occupancy from the newest assistant message past the compaction boundary
 * that carries tokens, TUI-identical: the TUI reads the last assistant message with a tokens
 * object, finished or still running, because the serve publishes the running turn's growing
 * counts on it. Requiring finished output held the previous turn while the TUI climbed
 * mid-turn (measured 193K held against 214.8K live). Null in the post-compaction gap and
 * when no turn has reported tokens, both of which the TUI draws as a blank meter rather
 * than a stale number.
 */
export function currentWindowTokens(
  messages: readonly {
    type?: unknown;
    role?: unknown;
    status?: unknown;
    tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } } | null;
  }[],
): number | null {
  const boundary = lastCompletedCompactionIndex(messages);
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  for (let i = messages.length - 1; i > boundary; i -= 1) {
    const message = messages[i]!;
    if (message.type !== "assistant" && message.role !== "assistant") continue;
    const tokens = message.tokens;
    if (!tokens) continue;
    const total =
      num(tokens.input) + num(tokens.output) + num(tokens.reasoning) + num(tokens.cache?.read) + num(tokens.cache?.write);
    if (total <= 0) continue;
    return total;
  }
  return null;
}

/** One model the serve offers, as the picker shows it. Costs are USD per million tokens. */
export interface OpencodeModel {
  providerID: string;
  modelID: string;
  name: string;
  contextLimit: number | null;
  inputCost: number | null;
  outputCost: number | null;
}

function readModelEntry(entry: { modelID?: unknown; providerID?: unknown; name?: unknown; limit?: unknown; cost?: unknown }): OpencodeModel | null {
  if (typeof entry.modelID !== "string" || typeof entry.providerID !== "string") return null;
  const limit = entry.limit as { context?: unknown } | undefined;
  const costs = Array.isArray(entry.cost) ? entry.cost[0] as { input?: unknown; output?: unknown } | undefined : undefined;
  return {
    providerID: entry.providerID,
    modelID: entry.modelID,
    name: typeof entry.name === "string" && entry.name ? entry.name : entry.modelID,
    contextLimit: typeof limit?.context === "number" ? limit.context : null,
    inputCost: typeof costs?.input === "number" ? costs.input : null,
    outputCost: typeof costs?.output === "number" ? costs.output : null,
  };
}

/** Every model the serve offers, for the picker and for limit resolution. */
export async function listOpencodeModels(): Promise<OpencodeModel[]> {
  const answered = await serveGet("/api/model");
  if (answered.status === 401) {
    resetOpencodeClient();
    throw new Error(`model list: unauthorized (${answered.status})`);
  }
  if (answered.status < 200 || answered.status >= 300) {
    throw new Error(`model list: serve answered ${answered.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(answered.text);
  } catch {
    throw new Error("model list: serve answered malformed JSON");
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error("model list: serve answered without models");
  return data.flatMap((entry) => {
    const model = readModelEntry(entry as { modelID?: unknown; providerID?: unknown });
    return model ? [model] : [];
  });
}

/** Context limits by `providerID/modelID`, for usage fractions. One GET, cached by the caller. */
export async function fetchOpencodeModelLimits(): Promise<Map<string, number>> {
  const limits = new Map<string, number>();
  for (const model of await listOpencodeModels()) {
    if (model.contextLimit !== null) limits.set(`${model.providerID}/${model.modelID}`, model.contextLimit);
  }
  return limits;
}

/**
 * Switches the session's model. The flat `{ providerID, id }` shape is this serve's own --
 * `modelID` is refused (measured) -- and the change lands on the session event like a rename.
 */
export async function switchOpencodeModel(sessionId: string, providerID: string, modelID: string): Promise<void> {
  const answered = await serveWrite("POST", `/api/session/${sessionId}/model`, {
    model: { providerID, id: modelID },
  });
  if (answered.status === 401) {
    resetOpencodeClient();
    throw new Error(`model switch: unauthorized (${answered.status})`);
  }
  if (answered.status < 200 || answered.status >= 300) {
    throw new Error(`model switch: serve answered ${answered.status} ${answered.text.slice(0, 200)}`);
  }
}

export interface StagedOpencodeFile {
  uri: string;
  mime: string;
  name: string;
}

export async function stageOpencodeAttachments(
  sessionId: string,
  requestId: string,
  attachments: readonly AgentMessageAttachment[],
): Promise<StagedOpencodeFile[]> {
  const directory = join(tmpdir(), "agentdesk-opencode", sessionId);
  await mkdir(directory, { recursive: true });
  const staged: StagedOpencodeFile[] = [];
  let index = 0;
  for (const attachment of attachments) {
    index += 1;
    const safeName = attachment.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "image";
    const path = join(directory, `${requestId}-${index}-${safeName}`);
    await writeFile(path, Buffer.from(attachment.data, "base64"), { mode: 0o644 });
    staged.push({ uri: `file://${path}`, mime: attachment.mime, name: attachment.name });
  }
  return staged;
}

/**
 * What the serve offers after a slash: built-ins plus custom commands from global
 * `~/.config/opencode/commands/` and the session project's `.opencode/commands/`.
 *
 * Uncached: the list is one small GET, and a file added mid-session must appear without a
 * restart lecture. (Whether the SERVE sees a new file without its own restart is its
 * business -- measured, a file added while it runs is not listed until then.)
 */
export async function listOpencodeServeCommands(): Promise<OpencodeSlashCommand[]> {
  const answered = await serveGet("/api/command");
  if (answered.status === 401) {
    resetOpencodeClient();
    throw new Error(`command list: unauthorized (${answered.status})`);
  }
  if (answered.status < 200 || answered.status >= 300) {
    throw new Error(`command list: serve answered ${answered.status}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(answered.text);
  } catch {
    throw new Error("command list: serve answered malformed JSON");
  }
  if (!Array.isArray((body as { data?: unknown }).data)) throw new Error("command list: serve answered without commands");
  const data = (body as { data: Array<{ name?: unknown; description?: unknown }> }).data;
  return data.flatMap((entry) =>
    typeof entry.name === "string" && entry.name.length > 0
      ? [{ name: entry.name, ...(typeof entry.description === "string" ? { description: entry.description } : {}) }]
      : [],
  );
}

/** Slash ops the TUI owns locally, answered here instead of by a server command. */
export const LOCAL_OPENCODE_COMMANDS: readonly OpencodeSlashCommand[] = [
  { name: "compact", description: "Summarize this session to free context" },
  { name: "undo", description: "Revert the last thing you said" },
  { name: "rename", description: "Rename this session" },
];

function checkLocalOp(path: string, status: number, text: string): void {
  if (status === 401) {
    resetOpencodeClient();
    throw new Error(`${path}: unauthorized (${status})`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`${path}: serve answered ${status} ${text.slice(0, 200)}`);
  }
}

/** Summarizes the session in place; the compaction lands as a timeline event like any turn. */
export async function compactOpencodeSession(sessionId: string): Promise<void> {
  // An explicit empty object: the serve rejects a bodiless POST (measured 400).
  const answered = await serveWrite("POST", `/api/session/${sessionId}/compact`, {});
  checkLocalOp("compact", answered.status, answered.text);
}

/** The last thing the person said, which is what undo reverts. Null when nothing can. */
export async function lastOpencodeUserMessage(sessionId: string): Promise<string | null> {
  const tail = await readOpencodeTail(sessionId);
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    if (tail[i]?.type === "user") return tail[i]!.id;
  }
  return null;
}

/** Reverts the last user message: stage, then commit, the serve's own two-step. */
export async function undoOpencodeSession(sessionId: string, messageId: string): Promise<void> {
  const staged = await serveWrite("POST", `/api/session/${sessionId}/revert/stage`, { messageID: messageId });
  checkLocalOp("revert stage", staged.status, staged.text);
  const committed = await serveWrite("POST", `/api/session/${sessionId}/revert/commit`, {});
  checkLocalOp("revert commit", committed.status, committed.text);
}

/** Renames the session; the new title arrives on the session event like any rename. */
export async function renameOpencodeSession(sessionId: string, title: string): Promise<void> {
  const answered = await serveWrite("PATCH", `/api/session/${sessionId}`, { title });
  checkLocalOp("rename", answered.status, answered.text);
}
