// Reading one session's whole history off the serve, oldest first.
//
// Two facts shape this file. The serve pages newest-first by default with a
// 50-message page, which silently drops a long session's older half; and the
// pinned SDK cannot express the cursor walk (`order`/`cursor` postdate its
// OpenAPI snapshot), so history travels one raw GET while everything else
// stays on the SDK. Revisit when the SDK is bumped: if its `messages` grows
// `order` and `cursor`, this file collapses back to the client.
//
// The walk mirrors opencode's own timeline: seed chronological from the
// oldest page forward (`order=asc`, then `cursor.next`), and thereafter read
// only the latest page -- durable messages are immutable once completed, so
// only the open tail can still move. The mapper sorts by creation time
// anyway, so page order is belt and braces rather than load-bearing.

import type { SessionMessage } from "@opencode-ai/sdk/v2/client";
import { serveGet } from "@/agents/opencode/opencodeClient";

/** History pages hold this many messages; the live tail reads one page. */
const HISTORY_PAGE_LIMIT = 200;
/** Bounds the seed walk: 50 pages hold ten thousand messages. */
const HISTORY_MAX_PAGES = 50;

interface HistoryPage {
  messages: SessionMessage[];
  next?: string;
}

async function readHistoryPage(sessionId: string, cursor?: string): Promise<HistoryPage> {
  const query = cursor
    ? `cursor=${encodeURIComponent(cursor)}&limit=${HISTORY_PAGE_LIMIT}`
    : `order=asc&limit=${HISTORY_PAGE_LIMIT}`;
  const answered = await serveGet(`/api/session/${sessionId}/message?${query}`);
  if (answered.status === 401) throw new Error(`messages: unauthorized (${answered.status})`);
  if (answered.status < 200 || answered.status >= 300) {
    throw new Error(`messages: serve answered ${answered.status} ${answered.text.slice(0, 200)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(answered.text);
  } catch {
    throw new Error("messages: serve answered malformed JSON");
  }
  const data = (body as { data?: unknown }).data;
  const cursorBody = (body as { cursor?: { next?: unknown } }).cursor;
  return {
    messages: Array.isArray(data) ? (data as SessionMessage[]) : [],
    next: typeof cursorBody?.next === "string" ? cursorBody.next : undefined,
  };
}

/**
 * Every message in the session for a fresh seed. Stops on an empty page, a
 * missing cursor, or a page that adds nothing new; the cap bounds a runaway,
 * and dedupe by id makes concurrent turns converge instead of duplicating.
 */
export async function readOpencodeHistory(
  sessionId: string,
): Promise<SessionMessage[]> {
  const seen = new Map<string, SessionMessage>();
  let cursor: string | undefined;
  for (let page = 0; page < HISTORY_MAX_PAGES; page++) {
    const { messages, next } = await readHistoryPage(sessionId, cursor);
    if (messages.length === 0) break;
    let progressed = false;
    for (const item of messages) {
      if (item && typeof item.id === "string" && !seen.has(item.id)) {
        seen.set(item.id, item);
        progressed = true;
      }
    }
    if (!progressed || !next) break;
    cursor = next;
  }
  return [...seen.values()];
}

/**
 * The session's latest page only: what a live refresh folds into a seeded
 * projection. One round trip; the mapper upserts by id, so concurrent
 * refreshes and event bursts converge rather than interleave.
 */
export async function readOpencodeTail(
  sessionId: string,
): Promise<SessionMessage[]> {
  const answered = await serveGet(`/api/session/${sessionId}/message?limit=${HISTORY_PAGE_LIMIT}`);
  if (answered.status === 401) throw new Error(`messages: unauthorized (${answered.status})`);
  if (answered.status < 200 || answered.status >= 300) {
    throw new Error(`messages: serve answered ${answered.status} ${answered.text.slice(0, 200)}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(answered.text);
  } catch {
    throw new Error("messages: serve answered malformed JSON");
  }
  const data = (body as { data?: unknown }).data;
  return Array.isArray(data) ? (data as SessionMessage[]) : [];
}
