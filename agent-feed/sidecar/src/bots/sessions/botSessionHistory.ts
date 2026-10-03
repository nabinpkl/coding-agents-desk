// Whether a session has ever worked in a Bot's directory, which is what attaching one asks.
//
// Attaching used to ask where the catalog files the session RIGHT NOW, and that answer is not
// stable for every session. A Claude session's project is the directory it opened in; when that
// directory is gone -- a project renamed under a running session -- the catalog falls back to the
// newest `cwd` in the transcript's tail, which is wherever the agent last ran a command. Measured
// 2026-10-03 on a session whose `import-graph` checkout became `reposhape`: its agent moved between
// the repository and its own scratchpad, and over the 2,064 writes after the rename the catalog's
// answer changed between the two 81 times. Attaching it worked or was refused depending on which
// second somebody asked.
//
// History only grows, so "has it ever worked here" cannot flip back the way "is it here now" does,
// and attaching is a person saying where a session belongs. The current answer is still asked
// first, because it is free and it is the ordinary case; the transcript is read only when it says
// no.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { directoryBelongsTo } from "@/git/worktree";
import type { ResolvedBotSession } from "@/bots/botTypes";
import { canonicalDirectory } from "@/transcripts/catalog/catalogRecords";

/**
 * Whether `session` has ever worked in `directory`, or in a git worktree of it.
 *
 * "Worked in" is the same predicate the Bot uses everywhere else: the directory itself or a
 * worktree linked to it, never a subdirectory. Being stricter here than there would refuse a
 * session the Bot then shows; being looser would let a session that once ran `cd ..` attach to the
 * parent directory's Bot.
 *
 * A source with no transcript file (opencode, whose project comes from its serve) answers from the
 * catalog alone, which for it is already stable.
 */
export async function sessionWorkedIn(
  session: ResolvedBotSession,
  directory: string,
): Promise<boolean> {
  if (await directoryBelongsTo(session.projectPath, directory)) return true;
  if (!session.transcriptPath) return false;
  // Canonicalised on both sides, because the transcript records whatever the shell said and a
  // worktree's link back to its checkout is a `realpath`. A directory that no longer exists cannot
  // be the Bot's, so a visited path that does not canonicalise is skipped rather than compared.
  const home = await canonicalDirectory(directory) ?? directory;
  for (const visited of await visitedDirectories(session.transcriptPath)) {
    if (visited === directory || visited === home) return true;
    const canonical = await canonicalDirectory(visited);
    if (canonical && await directoryBelongsTo(canonical, home)) return true;
  }
  return false;
}

/**
 * Every `cwd` a transcript records, once each.
 *
 * Streamed, because a long-lived session's transcript runs to tens of megabytes (32 MB for the one
 * that prompted this) and attaching is rare enough to read one end to end, but not to hold it.
 * Matched rather than parsed: a `cwd` key inside a tool's output is escaped and does not match, and
 * parsing every record of a 32 MB file to read one field is the expensive way to the same set.
 */
export async function visitedDirectories(transcriptPath: string): Promise<Set<string>> {
  const visited = new Set<string>();
  const lines = createInterface({ input: createReadStream(transcriptPath), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      for (const match of line.matchAll(CWD)) {
        try {
          visited.add(JSON.parse(`"${match[1]!}"`) as string);
        } catch {
          // An escape this cannot decode is a path nobody can compare against either.
        }
      }
    }
  } catch {
    // A transcript that cannot be read has no history to offer; the catalog's answer stands.
  } finally {
    lines.close();
  }
  return visited;
}

const CWD = /"cwd":"((?:[^"\\]|\\.)*)"/g;
