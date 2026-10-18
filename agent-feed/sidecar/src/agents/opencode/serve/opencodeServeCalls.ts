// Raw serve calls that own no session state: staging image bytes where the serve can read
// them, and listing what it offers after a slash. Both travel the raw path beside the SDK
// (see `opencodeClient.ts`) and both are pure over their arguments, which is what keeps them
// out of the backend: the backend owns sessions, the ledger and the projection, and none of
// that is needed to write a file or read a list.

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessageAttachment } from "@/agents/agentBackend";
import { resetOpencodeClient, serveGet, serveWrite } from "@/agents/opencode/serve/opencodeClient";
import { readOpencodeTail } from "@/agents/opencode/opencodeHistory";

/** One slash command the serve offers, as the composer picker shows it. */
export interface OpencodeSlashCommand {
  name: string;
  description?: string;
  /** Other names the same command answers to. The row shows `name`; these only match and parse. */
  aliases?: readonly string[];
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

/**
 * The panel's own slash commands, mirroring opencode's WEB client at v2.0.16 rather than its
 * TUI: `packages/app/src/composer/commands.tsx` and `packages/app/src/session/commands/
 * use-session-commands.tsx`. Descriptions are that client's own strings.
 *
 * The TUI is not the model here. It lists 34 built-ins and 21 of those open a dialog in a
 * terminal app -- exit, terminal, editor, pair, cd, worktrees, settings, themes, status, debug,
 * update, restart, reload, sessions, timeline, plugins, skills, diff, stats, help -- and a
 * browser has none of them. The web client is the same class of surface as this panel and
 * lists 13.
 *
 * Five of its 13 are absent because the panel has no such surface, and a row that cannot do
 * what it says is worse than a short list: `/open` (the IDE is workspace-scoped, not
 * session-scoped), `/terminal` (terminals hang off a Bot's canvas, not a session), `/mcp` and
 * `/agent` (opencode's own config and picker), `/connect` (provider sign-in).
 *
 * Two rows are not the web client's. `/models` is an alias of the web's `/model`, because that
 * name shipped here first and the panel's own model button has been saying `/models` since.
 * `/rename` is the TUI's, and it now sits beside the panel's own Rename dialog rather than
 * standing in for it: the web client has a dialog and no row, this panel has both, and they are
 * one rename -- the row and the dialog reach the same serve PATCH.
 *
 * Read the list against a checkout rather than against this comment when it needs checking: the
 * reference clone at `.reference/opencode` is the upstream tree (see `.gitignore`), and
 * `git clone --depth 1 --branch v2.0.16` puts it back.
 *
 * One row says more than the panel does. `/fork` carries the web client's own description, which
 * promises a session from a PREVIOUS MESSAGE, and the panel forks the whole history -- the
 * serve's own default when no message is named. It grows a message picker, or a shorter
 * description, when somebody wants to branch mid-conversation.
 */
export const LOCAL_OPENCODE_COMMANDS: readonly OpencodeSlashCommand[] = [
  { name: "model", aliases: ["models"], description: "Select a different model" },
  { name: "new", description: "New session" },
  { name: "undo", description: "Undo the last message" },
  { name: "redo", description: "Redo the last undone message" },
  { name: "compact", description: "Summarize the session to reduce context size" },
  { name: "fork", description: "Create a new session from a previous message" },
  { name: "export", description: "Export the full session transcript as JSON" },
  { name: "btw", description: "One-shot answer from the session's context without adding to the conversation" },
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

/**
 * Renames the session. Says nothing afterwards: measured on a live serve, the PATCH answers and no
 * `session.updated` follows it, so the caller is what tells the catalog -- see `applyRename`.
 */
export async function renameOpencodeSession(sessionId: string, title: string): Promise<void> {
  const answered = await serveWrite("PATCH", `/api/session/${sessionId}`, { title });
  checkLocalOp("rename", answered.status, answered.text);
}

/**
 * Drops a staged revert, which is what puts back what `/undo` took away. The serve's own two
 * steps mean there is nothing to undo here and there is something to redo: the stage is what
 * undo leaves behind, and clearing it is the whole of redo.
 */
export async function redoOpencodeSession(sessionId: string): Promise<void> {
  const answered = await serveWrite("DELETE", `/api/session/${sessionId}/revert`);
  checkLocalOp("redo", answered.status, answered.text);
}

/** The new session a fork made, as the panel needs to open it. */
export interface ForkedOpencodeSession {
  sessionId: string;
  title: string;
}

/**
 * Copies the projected history into a new session, whole or up to a message. Omitting the
 * message is the serve's own "copy everything" (`packages/protocol/src/groups/session.ts`), so
 * the panel's `/fork` needs no picker of its own to be useful.
 */
export async function forkOpencodeSession(sessionId: string, before?: string): Promise<ForkedOpencodeSession> {
  const answered = await serveWrite("POST", `/api/session/${sessionId}/fork`, before ? { before } : {});
  checkLocalOp("fork", answered.status, answered.text);
  const data = readServedData(answered.text, "fork") as { id?: unknown; title?: unknown } | undefined;
  if (!data || typeof data.id !== "string" || data.id.length === 0) {
    throw new Error("fork: serve answered without a session id");
  }
  return { sessionId: data.id, title: typeof data.title === "string" ? data.title : data.id };
}

/** The whole projected transcript, which is what the web client's `/export` writes to a file. */
export async function exportOpencodeSession(sessionId: string): Promise<unknown> {
  const answered = await serveGet(`/api/experimental/session/${sessionId}/export`);
  if (answered.status === 401) {
    resetOpencodeClient();
    throw new Error(`export: unauthorized (${answered.status})`);
  }
  if (answered.status < 200 || answered.status >= 300) {
    throw new Error(`export: serve answered ${answered.status} ${answered.text.slice(0, 200)}`);
  }
  return readServedData(answered.text, "export");
}

/**
 * The TUI's `/btw`, word for word (`packages/tui/src/feature-plugins/prompt/btw.tsx`): one
 * answer from the session's context, adding nothing to the conversation. `session.generate`
 * runs no tool loop, which is why the instruction says so out loud -- a tool call there would
 * surface as an empty answer.
 */
export async function askOpencodeAside(sessionId: string, question: string): Promise<string> {
  const instructions = [
    "The user is asking a quick side question about the conversation so far.",
    "Answer directly and concisely in markdown from what you already know.",
    "Do not call any tools and do not take any actions.",
  ].join(" ");
  const answered = await serveWrite("POST", `/api/session/${sessionId}/generate`, {
    prompt: `${instructions}\n\n${question}`,
  });
  checkLocalOp("aside", answered.status, answered.text);
  const data = readServedData(answered.text, "aside") as { text?: unknown } | undefined;
  return typeof data?.text === "string" ? data.text : "";
}

/** The serve's `{data: …}` envelope, unwrapped. Throws with the caller's own name on a shape it did not send. */
function readServedData(text: string, caller: string): unknown {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${caller}: serve answered malformed JSON`);
  }
  const data = (body as { data?: unknown }).data;
  if (data === undefined) throw new Error(`${caller}: serve answered without data`);
  return data;
}
