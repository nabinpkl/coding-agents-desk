// A subagent's transcript, streamed to whoever is looking at the run.
//
// The path is DERIVED, never supplied. `agentId` is fenced to hex so it cannot name a directory
// or climb out of one, and the file is then built from the parent session's own transcript
// location. That is the same rule `taskRoutes` states for task output and for the same reason:
// this endpoint is reachable from a phone, and a route that opened a path a caller handed it
// would be a read oracle over everything the sidecar can open (ADR-0099).
//
// The index is keyed on the parent session AND the agent, which is what keeps a subagent's lines
// out of the session's own timeline. Every record in these files carries the PARENT's sessionId,
// so a key built from the record's own contents would collide by construction. `ensureIndexed`
// takes the path as an argument and treats the key as opaque, so a composite key reuses the whole
// index -- build, tail, fan-out -- with no change to it.

import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ActivityEvent,
  SubagentForkOrigin,
  SubagentTranscriptMessage,
} from "@agentdesk/agent-feed-wire";
import { encodeServerSentEvent, startServerSentEventStream } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";
import {
  followTranscript,
  readEvents,
  subscribeEvents,
} from "@/transcripts/event-index/eventIndex";
import { claudeTranscriptPath } from "@/tasks/taskIdentity";

// Hex only, and bounded. A subagent id is 17 hex characters today; the width is loose so a
// change to that does not become a 404, but the alphabet is not, because the alphabet is the
// whole of the traversal defence.
const TRANSCRIPT_ROUTE =
  /^\/api\/sessions\/claude\/([0-9a-fA-F-]{36})\/agents\/([0-9a-fA-F]{1,64})\/transcript$/;

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
        const release = followTranscript("claude", key, path, () => {});

        // Subscribed BEFORE the opening read, because the read is what builds the index and the
        // index fans events out as it parses them -- so subscribing afterwards drops everything
        // that arrived while it ran. The cost is that those same events reach this subscriber
        // before the snapshot exists to append them to, which is why they are held rather than
        // sent, and then filtered by the snapshot's own length: a nice index below it is already
        // in the snapshot, and one at or above it is genuinely new.
        let snapshotLength: number | null = null;
        const held: { index: number; event: ActivityEvent }[] = [];
        const unsubscribe = subscribeEvents("claude", key, (notice) => {
          // A machinery line has no nice index and is not part of what this viewer reads.
          if (notice.niceIndex === null) return;
          if (snapshotLength === null) {
            held.push({ index: notice.niceIndex, event: notice.event });
            return;
          }
          // Append only. Each event is handed out once, so this viewer's list only ever grows --
          // the property the session timeline had to be taught.
          if (notice.niceIndex < snapshotLength) return;
          send({ kind: "append", event: notice.event });
        });
        cleanup = () => {
          unsubscribe();
          release();
        };
        if (closed) {
          // Left while the index was being built. Release what was just acquired rather than
          // waiting for a teardown that has already run.
          cleanup();
          return;
        }

        // Subscribed BEFORE the opening read, so an event parsed while it runs is appended rather
        // than lost in the gap between the two. A duplicate at the seam is the safer failure and
        // the index does not produce one: it fans each event out once, as it is first parsed.
        const forkOrigin = await readForkOrigin(path);
        // The whole run, not a tail. See the note on `SubagentTranscriptMessage`.
        const events = await readEvents("claude", key, path, 0, Number.MAX_SAFE_INTEGER, "nice");
        send({
          kind: "snapshot",
          agentId,
          events,
          total: events.length,
          ...(forkOrigin ? { forkOrigin } : {}),
        });
        snapshotLength = events.length;
        for (const { index, event } of held) {
          if (index < snapshotLength) continue;
          send({ kind: "append", event });
        }
        held.length = 0;
      })();

      return () => {
        closed = true;
        cleanup?.();
      };
    });
  };
}
