// The newest `<task-state>` block each opencode session opened a response with.
//
// opencode keeps no transcript file to read from the end, and the catalog lists sessions without
// opening any of them. So the block is caught where the serve already tells this process about
// every session's words: its one event stream closes each text part with the whole part
// (`session.text.ended`), and a part that opens with the tag is this session's report. Nothing is
// asked for that, which keeps it to no request per turn.
//
// What the stream cannot give is a block written before this process started, and the sidecar
// restarts on every edit to it. So a session the catalog lists as recently active is looked up once
// per process, from the newest page of its messages.

import { serveGet } from "@/agents/opencode/serve/opencodeClient";
import type { Session } from "@/transcripts/transcriptTypes";
import { state } from "@/transcripts/transcriptState";
import { scheduleBroadcast, sessionKey } from "@/transcripts/catalog/catalogState";
import { parseTaskState, type SessionTaskState } from "@/transcripts/taskState";

const known = new Map<string, SessionTaskState>();
/** Sessions already looked up this process, found or not. */
const looked = new Set<string>();
let lookingUp = false;

/** Only sessions active this recently are looked up at start: an older one has no block to find. */
const LOOKUP_WITHIN_MS = 24 * 60 * 60 * 1000;
/** The newest messages a lookup reads. A block opens a response, so it sits near the end. */
const LOOKUP_MESSAGES = 30;

/** The block a session is known to have written, for the catalog's record of it. */
export function opencodeTaskState(sessionId: string): SessionTaskState | undefined {
  return known.get(sessionId);
}

/** A text part the serve finished writing. Its session's block, when the part opens with one. */
export function noteOpencodeText(sessionId: string, text: string, at: number): void {
  const found = parseTaskState(text, at);
  if (found) remember(sessionId, found);
}

/** Looks up, once each, the recently active sessions whose block this process has not seen. */
export function lookUpOpencodeTaskStates(sessions: Iterable<Session>, now = Date.now()): void {
  const due = [...sessions].filter(
    (session) =>
      session.source === "opencode" && !looked.has(session.sessionId) && now - session.lastEventAt < LOOKUP_WITHIN_MS,
  );
  for (const session of due) looked.add(session.sessionId);
  if (due.length === 0 || lookingUp) return;
  lookingUp = true;
  // One at a time: a sidecar that just started has a reconcile, a catalog and every stream to
  // answer, and none of these is urgent.
  void (async () => {
    try {
      for (const session of due) {
        const found = await newestInServe(session.sessionId).catch(() => null);
        if (found) remember(session.sessionId, found);
      }
    } finally {
      lookingUp = false;
    }
  })();
}

function remember(sessionId: string, found: SessionTaskState): void {
  const previous = known.get(sessionId);
  if (previous && previous.at > found.at) return;
  known.set(sessionId, found);
  const record = state.sessions.get(sessionKey("opencode", sessionId));
  if (!record) return;
  record.taskState = found;
  scheduleBroadcast();
}

interface ServeMessage {
  type?: string;
  time?: { created?: number };
  content?: { type?: string; text?: string }[];
}

async function newestInServe(sessionId: string): Promise<SessionTaskState | null> {
  // Newest first by default, which is the end a block is at.
  const answered = await serveGet(`/api/session/${encodeURIComponent(sessionId)}/message?limit=${LOOKUP_MESSAGES}`);
  if (answered.status < 200 || answered.status >= 300) return null;
  const data = (JSON.parse(answered.text) as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  let newest: SessionTaskState | null = null;
  for (const message of data as ServeMessage[]) {
    if (message?.type !== "assistant" || !Array.isArray(message.content)) continue;
    const at = message.time?.created ?? 0;
    for (const part of message.content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      const found = parseTaskState(part.text, at);
      if (found && (!newest || found.at > newest.at)) newest = found;
    }
  }
  return newest;
}
