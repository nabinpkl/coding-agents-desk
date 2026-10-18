// A subagent's transcript, streamed to whoever is looking at the run.
//
// The path is DERIVED, never supplied. `agentId` is fenced to hex so it cannot name a directory
// or climb out of one, and the file is then built from the parent session's own transcript
// location. That is the same rule `taskRoutes` states for task output and for the same reason:
// this endpoint is reachable from a phone, and a route that opened a path a caller handed it
// would be a read oracle over everything the sidecar can open (ADR-0099).
//
// The follow is keyed on the parent session AND the agent, which is what keeps a subagent's lines
// out of the session's own timeline. Every record in these files carries the PARENT's sessionId,
// so a key built from the record's own contents would collide by construction. The transcript
// reads take the path as an argument and treat the key as opaque, so a composite key reuses the
// whole of them -- pages, follow, fan-out -- with no change.

import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SubagentForkOrigin, SubagentTranscriptMessage } from "@agentdesk/agent-feed-wire";
import { encodeServerSentEvent, startServerSentEventStream } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import { followTranscript } from "@/transcripts/transcript-reads/transcriptFollow";
import { completeEnd } from "@/transcripts/transcript-reads/transcriptLines";
import {
  eventsOf,
  parsedLinesBetween,
  type ParsedTranscriptLine,
} from "@/transcripts/transcript-reads/transcriptPages";
import { claudeTranscriptPath } from "@/tasks/taskIdentity";

// Hex only, and bounded. A subagent id is 17 hex characters today; the width is loose so a
// change to that does not become a 404, but the alphabet is not, because the alphabet is the
// whole of the traversal defence.
const TRANSCRIPT_ROUTE = /^\/api\/sessions\/claude\/([0-9a-fA-F-]{36})\/agents\/([0-9a-fA-F]{1,64})\/transcript$/;

/** Everything a subagent index needs to be told apart from the session that launched it. */
function indexKey(sessionId: string, agentId: string): string {
  return `${sessionId}/agent/${agentId}`;
}

async function transcriptPath(sessionId: string, agentId: string): Promise<string | null> {
  const parent = await claudeTranscriptPath(sessionId);
  if (!parent) return null;
  // `<projects>/<slug>/<sessionId>.jsonl` has a sibling directory of the same name holding the
  // runs it launched. Built from the parent's resolved path rather than from config, so a session
  // found under an aliased project root keeps its subagents.
  const directory = join(dirname(parent), sessionId, "subagents");
  const candidate = join(directory, `agent-${agentId}.jsonl`);
  try {
    await stat(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * The `fork-context-ref` header, when the run is a fork and still carries one.
 *
 * It is always the first line, so this reads one line rather than scanning. Absent for every
 * other subagent type, and absent for a fork whose file has been truncated, both of which are
 * reported as "no origin" rather than as an error.
 */
async function readForkOrigin(path: string): Promise<SubagentForkOrigin | undefined> {
  let head: string;
  try {
    head = await Bun.file(path).slice(0, 4096).text();
  } catch {
    return undefined;
  }
  const firstLine = head.split("\n", 1)[0];
  if (!firstLine || !firstLine.startsWith("{")) return undefined;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    // A first line still being written is not an error; the rest of the file reads fine.
    return undefined;
  }
  if (record.type !== "fork-context-ref") return undefined;
  const parentSessionId = record.parentSessionId;
  const parentMessageUuid = record.parentLastUuid;
  const contextLength = record.contextLength;
  if (typeof parentSessionId !== "string" || typeof parentMessageUuid !== "string") return undefined;
  return {
    parentSessionId,
    parentMessageUuid,
    contextLength: typeof contextLength === "number" ? contextLength : 0,
  };
}

export function createSubagentRoutes(): RouteHandler {
  return (request, url, server) => {
    const match = TRANSCRIPT_ROUTE.exec(url.pathname);
    if (!match || request.method !== "GET") return undefined;
    const sessionId = match[1]!;
    const agentId = match[2]!;

    return startServerSentEventStream(request, server, (write) => {
      // The stream's cleanup must be handed back synchronously, but everything this reader needs
      // is on disk. So setup runs detached and the teardown it produces is latched -- and the
      // `closed` flag is not decoration: a viewer that leaves before the first read returns would
      // otherwise install a follow and a subscription that nothing is left to release.
      let cleanup: (() => void) | null = null;
      let closed = false;

      const send = (message: SubagentTranscriptMessage): void => {
        if (closed) return;
        write(encodeServerSentEvent(message));
      };

      void (async () => {
        const path = await transcriptPath(sessionId, agentId);
        if (!path) {
          // A run can be launched and not have written yet, and a run whose parent session cannot
          // be located looks identical from here. Neither is a 404: the caller asked about an
          // agent it just saw in the task snapshot, and the honest answer is "nothing yet".
          send({ kind: "unavailable", reason: "no transcript on disk yet" });
          return;
        }

        const key = indexKey(sessionId, agentId);
        // Listening BEFORE the opening read, so a line written while it runs is held rather than
        // lost in the gap between the two; anything at or before the newest line already sent is
        // dropped at the seam. Lines go out in file order, each once, so this viewer's list only
        // ever grows -- the property the session timeline had to be taught.
        let ready = false;
        let delivered = -1;
        let last: number | null = null;
        const held: ParsedTranscriptLine[] = [];
        const deliver = (line: ParsedTranscriptLine): void => {
          if (line.position <= delivered) return;
          delivered = line.position;
          const [event] = eventsOf("claude", key, [line], "nice", last);
          if (!event) return;
          last = event.index;
          send({ kind: "append", event });
        };
        const follow = followTranscript(
          "claude",
          key,
          path,
          (line) => {
            if (ready) deliver(line);
            else held.push(line);
          },
          () => {},
        );
        cleanup = () => follow.release();
        if (closed) {
          cleanup();
          return;
        }

        const forkOrigin = await readForkOrigin(path);
        // The whole run, not a tail. See the note on `SubagentTranscriptMessage`.
        const end = await completeEnd(path);
        const events = eventsOf("claude", key, await parsedLinesBetween("claude", path, 0, end), "nice", null);
        send({
          kind: "snapshot",
          agentId,
          events,
          total: events.length,
          ...(forkOrigin ? { forkOrigin } : {}),
        });
        delivered = end - 1;
        last = events.at(-1)?.index ?? null;
        const from = follow.start(end, { usage: null, model: undefined });
        if (from > end) {
          for (const line of await parsedLinesBetween("claude", path, end, from)) deliver(line);
        }
        ready = true;
        for (const line of held.splice(0)) deliver(line);
      })();

      return () => {
        closed = true;
        cleanup?.();
      };
    });
  };
}
