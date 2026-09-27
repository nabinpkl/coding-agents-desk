// Staging image bytes where the serve can read them: it takes URIs, not bytes.
//
// One directory per session under the OS temp root, 0644 so the serve's user can read them.
// Kept, not cleaned: the model re-reads by URI mid-turn (measured: a read-tool call against
// the staged path after the send), so deleting after the prompt would pull the file out from
// under a running turn. The cost is one directory per session that ever received an image,
// reclaimed with the temp root.

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessageAttachment } from "@/agents/agentBackend";

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
