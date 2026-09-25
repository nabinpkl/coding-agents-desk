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
