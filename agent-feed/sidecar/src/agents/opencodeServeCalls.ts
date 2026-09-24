// Raw serve calls that own no session state: staging image bytes where the serve can read
// them, and listing what it offers after a slash. Both travel the raw path beside the SDK
// (see `opencodeClient.ts`) and both are pure over their arguments, which is what keeps them
// out of the backend: the backend owns sessions, the ledger and the projection, and none of
// that is needed to write a file or read a list.

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessageAttachment } from "@/agents/agentBackend";
import { resetOpencodeClient, serveGet } from "@/agents/opencodeClient";

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
