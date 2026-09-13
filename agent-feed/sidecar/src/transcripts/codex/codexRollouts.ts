// Where Codex keeps its rollouts and its state database, and how to ask a rollout
// whether its last turn finished without reading the whole thing.

import { basename, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { config } from "@/config";
import { turnClosedFor } from "@/transcripts/codex/codexPayloads";

const CODEX_HOME = config.codexHomeDirectory;

// Picks the highest-version state_<N>.sqlite. Codex migrates this DB and
// bumps the suffix; globbing keeps the adapter working across version bumps
// without a code change as long as the columns we read remain present.
export function resolveStateDbPath(): string | null {
  let entries: string[] = [];
  try { entries = readdirSync(CODEX_HOME); } catch { return null; }
  let best: { n: number; path: string } | null = null;
  for (const name of entries) {
    const m = /^state_(\d+)\.sqlite$/.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (!best || n > best.n) best = { n, path: join(CODEX_HOME, name) };
  }
  return best?.path ?? null;
}

/**
 * Turn state as of the end of a rollout, from a bounded read of its last bytes.
 *
 * Codex's inventory comes from SQLite, so unlike Claude nothing else opens the
 * rollout file to build a session record -- this read is new work, and the
 * catalog only asks for it for sessions inside the live window, where the answer
 * can still change which bin the row lands in.
 *
 * Undefined when the window carries no boundary line, which the caller reads as
 * "assume closed" rather than guessing from further back.
 */
export async function readTail(filePath: string, bytes: number): Promise<boolean | undefined> {
  let fh: Awaited<ReturnType<typeof open>>;
  try { fh = await open(filePath, 'r'); } catch { return undefined; }
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(size, bytes));
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf-8', 0, bytesRead).split('\n');
    // A window that starts mid-file almost certainly starts mid-line.
    if (start > 0) lines.shift();
    let closed: boolean | undefined;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        // Last one in the window wins: this is the turn state as of the most
        // recent line that spoke to it.
        const next = turnClosedFor(parsed as { type?: string; payload?: Record<string, unknown> });
        if (next !== undefined) closed = next;
      } catch { continue; }
    }
    return closed;
  } finally {
    await fh.close();
  }
}
