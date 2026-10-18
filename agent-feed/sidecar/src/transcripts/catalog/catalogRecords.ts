// Turning a file on disk into a catalog record, and resolving the directory it belongs to.
//
// Shared by all three sources: a session record has the same shape whoever wrote it, and
// every source has to canonicalise a path before it can be compared to another one.

import { realpath, stat } from "node:fs/promises";
import { basename, relative } from "node:path";
import { config } from "@/config/config";
import type { LastSelection, Session, SourceId } from "@/transcripts/transcriptTypes";
import type { SessionTaskState } from "@/transcripts/taskState";
import {
  CLAUDE_SESSION_PATTERN,
  PROMPT_TITLE_CHARACTERS,
  SUMMARY_TITLE_CHARACTERS,
} from "@/transcripts/catalog/catalogState";

export async function canonicalDirectory(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path);
    const metadata = await stat(resolved);
    return metadata.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

export async function canonicalProjectPath(path: string): Promise<string | null> {
  if (!path.startsWith("/")) return null;
  return canonicalDirectory(path);
}

export function isClaudeSessionCandidate(
  filePath: string,
  projectsDirectory = config.claudeProjectsDirectory,
): boolean {
  if (!CLAUDE_SESSION_PATTERN.test(basename(filePath))) return false;
  const components = relative(projectsDirectory, filePath).split(/[\\/]/);
  return components.length === 2 && components.every((component) => component.length > 0 && component !== "..");
}

export function makeSession(
  source: SourceId,
  sessionId: string,
  project: string,
  transcriptPath: string | undefined,
  lastEventAt: number,
  metadata: {
    title?: string;
    gitBranch?: string;
    entrypoint?: string;
    lastEntrypoint?: string;
    lastSelection?: LastSelection;
    lastTurnClosed?: boolean;
    firstPrompt?: string;
    taskState?: SessionTaskState;
  } = {},
): Session {
  return {
    sessionId,
    source,
    project,
    transcriptPath,
    lastEventAt,
    ...metadata,
    // Bounded on the way IN, not just on the way out. The catalog holds one of these
    // per session -- 1290 of them on this machine -- and a prompt is arbitrary text a
    // person pasted, so the record must not be the thing that grows with it.
    title: compactTitle(metadata.title),
    firstPrompt: compactTitle(metadata.firstPrompt?.slice(0, PROMPT_TITLE_CHARACTERS)),
  };
}

export function compactTitle(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= SUMMARY_TITLE_CHARACTERS
    ? normalized
    : `${normalized.slice(0, SUMMARY_TITLE_CHARACTERS - 1)}…`;
}
