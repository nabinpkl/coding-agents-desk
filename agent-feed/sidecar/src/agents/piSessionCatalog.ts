import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { config } from "@/config";
import type { Session } from "@/transcripts/sources/transcriptTypes";
import type { PiSessionLocation } from "@/agents/piAgentBackend";

const PROBE_BYTES = 32 * 1024;
const PI_SESSION_FILE = /_([0-9a-f-]{36})\.jsonl$/i;

interface PiHeader {
  type?: unknown;
  id?: unknown;
  cwd?: unknown;
}

export async function scanPiSessions(): Promise<Session[]> {
  let projectDirectories: string[];
  try {
    projectDirectories = await readdir(config.piSessionsDirectory);
  } catch {
    return [];
  }
  const candidates: string[] = [];
  for (const directory of projectDirectories) {
    const path = join(config.piSessionsDirectory, directory);
    let files: string[];
    try {
      files = await readdir(path);
    } catch {
      continue;
    }
    for (const file of files) {
      if (PI_SESSION_FILE.test(file)) candidates.push(join(path, file));
    }
  }
  const sessions = await Promise.all(candidates.map((path) => readPiSessionCandidate(path)));
  return sessions.filter((session): session is Session => session !== null);
}

export async function readPiSessionCandidate(
  path: string,
  sessionsDirectory = config.piSessionsDirectory,
): Promise<Session | null> {
  const match = PI_SESSION_FILE.exec(basename(path));
  if (!match) return null;
  let canonicalPath: string;
  let canonicalSessionsDirectory: string;
  let metadata: Awaited<ReturnType<typeof stat>>;
  try {
    canonicalPath = await realpath(path);
    canonicalSessionsDirectory = await realpath(sessionsDirectory);
    metadata = await stat(canonicalPath);
  } catch {
    return null;
  }
  const location = relative(canonicalSessionsDirectory, canonicalPath);
  if (location.startsWith("..") || location.split(/[\\/]/).length !== 2) return null;
  const text = await Bun.file(canonicalPath).slice(0, Math.min(metadata.size, PROBE_BYTES)).text();
  const lines = text.split("\n");
  let header: PiHeader;
  try {
    header = JSON.parse(lines[0] ?? "") as PiHeader;
  } catch {
    return null;
  }
  if (
    header.type !== "session" ||
    typeof header.id !== "string" ||
    header.id !== match[1] ||
    typeof header.cwd !== "string"
  ) {
    return null;
  }
  let project: string;
  try {
    project = await realpath(header.cwd);
    if (!(await stat(project)).isDirectory()) return null;
  } catch {
    return null;
  }
  return {
    sessionId: header.id,
    source: "pi",
    project,
    transcriptPath: canonicalPath,
    lastEventAt: metadata.mtimeMs,
    title: firstUserPrompt(lines) ?? header.id,
    entrypoint: "pi",
  };
}

export function piLocation(session: Session): PiSessionLocation {
  return {
    sessionId: session.sessionId,
    projectPath: session.project,
    transcriptPath: session.transcriptPath,
    title: session.title ?? session.sessionId,
    lastEventAt: session.lastEventAt,
  };
}

function firstUserPrompt(lines: string[]): string | undefined {
  for (const line of lines.slice(1)) {
    if (!line) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record) || record.type !== "message" || !isRecord(record.message)) continue;
    if (record.message.role !== "user") continue;
    const text = messageText(record.message.content).replace(/\s+/g, " ").trim();
    if (text) return text.length <= 240 ? text : `${text.slice(0, 239)}…`;
  }
  return undefined;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) =>
    isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []
  ).join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
