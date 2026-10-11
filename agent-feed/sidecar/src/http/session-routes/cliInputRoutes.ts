// Typing into a Claude session that is running in someone's terminal.
//
// Claude-only by construction rather than by policy: the inbox this writes to is something the
// Claude harness publishes, and no other source has an equivalent. Codex is refused here with a
// 404 from the route pattern rather than a runtime check, so the panel learns it from the shape of
// the API instead of from an error string.
//
// GET answers whether a turn can be delivered, and never writes. The panel asks it to decide which
// composer to show, so it has to be free of side effects: a status poll that put an empty turn in
// someone's session would be the worst kind of bug to find.

import type { CliInputReceipt, CliInputStatus } from "@agentdesk/agent-feed-wire";
import {
  cliInputStatus,
  deliverCliInput,
  MAXIMUM_INPUT_BYTES,
} from "@/input/claudeSessionInbox";
import { jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const INPUT_ROUTE = /^\/api\/sessions\/claude\/([0-9a-f-]{36})\/input$/i;

/**
 * The inbox, injected.
 *
 * Not a testing affordance bolted on: what this file owns is the address shape and what a caller
 * is allowed to send, and both are worth pinning without a live Claude process on the machine
 * running the suite. The inbox's own behaviour is pinned against a real socket next door.
 */
export interface CliInputDependencies {
  status: (sessionId: string) => Promise<CliInputStatus>;
  deliver: (sessionId: string, text: string) => Promise<CliInputReceipt>;
}

const LIVE: CliInputDependencies = {
  status: (sessionId) => cliInputStatus(sessionId),
  deliver: (sessionId, text) => deliverCliInput(sessionId, text),
};

export function createCliInputRoutes(inbox: CliInputDependencies = LIVE): RouteHandler {
  return (request, url) => {
    const match = INPUT_ROUTE.exec(url.pathname);
    if (!match) return undefined;
    const sessionId = match[1]!.toLowerCase();
    if (request.method === "GET") return status(inbox, sessionId);
    if (request.method === "POST") return deliver(inbox, request, sessionId);
    return undefined;
  };
}

async function status(inbox: CliInputDependencies, sessionId: string): Promise<Response> {
  return jsonResponse(await inbox.status(sessionId));
}

async function deliver(
  inbox: CliInputDependencies,
  request: Request,
  sessionId: string,
): Promise<Response> {
  let body: { text?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return jsonResponse({ error: "invalid json body" }, 400);
  }
  const text = typeof body.text === "string" ? body.text : null;
  // A blank turn is refused rather than delivered. The harness would accept it, and it would land
  // in the session as an empty user message that costs a model call to answer.
  if (text === null || text.trim() === "") {
    return jsonResponse({ error: "text is required" }, 400);
  }
  if (Buffer.byteLength(text, "utf8") > MAXIMUM_INPUT_BYTES) {
    return jsonResponse({ error: "text is too large" }, 413);
  }
  const receipt: CliInputReceipt = await inbox.deliver(sessionId, text);
  // 200 either way, with the outcome in the body. An undelivered turn is an ANSWER, not a
  // protocol failure: "that session is not running" is a fact the panel renders, and dressing it
  // as a 4xx would make it indistinguishable from a malformed request in every client that
  // branches on status before reading the body. 4xx above stays for what really is the caller's
  // fault -- a missing turn, an oversized one, a body that is not JSON.
  return jsonResponse(receipt);
}
