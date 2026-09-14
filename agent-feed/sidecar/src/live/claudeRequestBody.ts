// What a captured `/v1/messages` REQUEST says: whose session it belongs to, whether a subagent sent
// it, and which tool results it carries back from the turn before.
//
// Split out of `claudeNetworkSource.ts`, which reads the other direction. That file is about the
// stream coming back -- SSE framing, decompression, and the Anthropic event shapes -- and this one
// is about the body that went out. The two met only because both are reached through the proxy's
// observer, which is a transport rather than a concept.
//
// Everything here parses something another program wrote, so everything here is defensive: an
// unreadable field is absent rather than a throw, and each fallback says which way it fails.

/** Fetches a retained request body and returns the claude `session_id` it names, if any. */
export async function fetchSessionIdFromBody(
  endpoint: URL,
  bodyReference: string,
): Promise<string | null> {
  const response = await fetch(new URL(`/v1/bodies/${bodyReference}`, endpoint), {
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok) return null;
  const text = await response.text();
  return extractSessionId(text);
}

/**
 * Reads `session_id` out of a captured `/v1/messages` request body. The Anthropic
 * request carries the local claude identity as a JSON-encoded string in the `user`
 * parameter (and, in recent harness versions, a literal top-level `user_id`), with
 * the shape `{"device_id":..., "account_uuid":..., "session_id":...}`. That
 * `session_id` is the same id agent-feed keys claude sessions by (the transcript
 * basename), which is what makes network flows correlatable to sessions.
 */
export interface RequestMetadata {
  sessionId: string | null;
  toolResults: ToolResultItem[];
  /** This request belongs to a SUBAGENT of that session rather than to the session itself. */
  subagent: boolean;
  /**
   * This request is the session SPEAKING -- serving a prompt somebody typed -- rather than one of
   * the harness's own errands run under the session's identity.
   */
  conversationTurn: boolean;
}

export interface ToolResultItem {
  toolUseId?: string;
  text: string;
}

/** Fetches a retained request body and returns the claude session id and any
 *  `tool_result` payloads it carries in its final user message. */
export async function fetchRequestMetadata(
  endpoint: URL,
  bodyReference: string,
): Promise<RequestMetadata> {
  const response = await fetch(new URL(`/v1/bodies/${bodyReference}`, endpoint), {
    headers: { accept: "application/octet-stream" },
  });
  if (!response.ok) {
    return { sessionId: null, toolResults: [], subagent: false, conversationTurn: true };
  }
  const text = await response.text();
  return {
    sessionId: extractSessionId(text),
    toolResults: extractToolResults(text),
    subagent: isSubagentRequest(text),
    conversationTurn: isConversationTurn(text),
  };
}

/**
 * Whether a captured `/v1/messages` request was made BY a subagent rather than by the session whose
 * id it carries.
 *
 * It carries the parent's id, and that is not a bug in the harness: a subagent is the parent's tool
 * call, billed and rate-limited against the parent's session, so the identity it sends is the
 * parent's. The consequence here is that a subagent's whole streamed answer binds to the parent's
 * live projection and appears inside the parent's transcript view -- text the parent never said,
 * arriving while the parent sits blocked waiting for it. The durable side has never had this
 * problem: a subagent's lines are written to `<session>/subagents/agent-<id>.jsonl`, flagged
 * `isSidechain`, and the catalog keys sessions by transcript basename, so nothing merges.
 *
 * What tells them apart is the harness's own billing header, which rides in the system prompt.
 * Measured across 24 flows on 2026-09-11, with two throwaway subagents run to produce the positive
 * case. A subagent sends:
 *
 *     x-anthropic-billing-header: cc_version=2.1.268.58f; cc_entrypoint=cli; cch=eeb8b;
 *     cc_is_subagent=true; cc_prompt_id=...
 *
 * and an ordinary turn sends the same header WITHOUT that pair at all -- not with a false value,
 * which is what this was first written to expect. So presence is the signal.
 *
 * Read out of the SYSTEM blocks and nowhere else, which is the part that was measured the hard way.
 * Searching the whole body matched 2 of those 24 flows wrongly, and both were this very session's
 * own turns: the token appeared in a `tool_result` because the conversation was ABOUT the token.
 * That is not a contrived case -- any session reading this file, or reviewing the commit that added
 * it, puts the string in its own next request -- and the cost of getting it wrong is a live mirror
 * that goes silent for the one session looking into why. The conversation lives in `messages`; the
 * header lives in `system`; only one of those is the harness talking.
 *
 * An unparseable body, or one with no system prompt, reads as not-a-subagent. That is the right way
 * round: the failure is the merging bug coming back, not a session that can no longer be watched.
 */
export function isSubagentRequest(requestBody: string): boolean {
  return /cc_is_subagent\s*=\s*true/i.test(systemPromptText(requestBody));
}

/**
 * Whether a captured `/v1/messages` request is the session SPEAKING, rather than one of the
 * harness's own errands run under the session's identity.
 *
 * The same failure as the subagent case above, found the same way, and fixed the same way. The
 * harness makes calls that are not turns: the compaction summariser, which reads the whole context
 * and writes the summary that replaces it, and the composer's suggestion call, which guesses what
 * the reader is about to type. Both carry the session's own `session_id` and neither is a subagent,
 * so both bind to its live projection and stream into the thread as if the assistant had said them.
 *
 * The summariser is the one that gets noticed, because of where it lands. It runs for minutes and
 * writes thousands of words, and it arrives at exactly the moment the feed should be saying the
 * context was reset -- so the compaction banner ends up buried under half a summary nobody wrote.
 * That is the report this rule came from.
 *
 * What tells them apart is `cc_prompt_id` in the harness's billing header: a request serving a
 * prompt somebody typed carries that prompt's id, and an errand has no prompt to name. Measured
 * across 14 captured flows on 2026-09-14, with a throwaway session compacted twice to produce the
 * positive case -- 10 ordinary turns carried it, both summariser calls and the one suggestion call
 * did not. Nothing else separates them: `cc_prev_req` is on almost everything, and the bodies'
 * `thread` and `diagnostics` keys were on some ordinary turns and absent from others.
 *
 * Read out of the SYSTEM blocks for the reason written above: the conversation lives in `messages`,
 * and a session discussing this rule would otherwise match its own prose.
 *
 * A body with no billing header at all reads as a turn, and that direction is deliberate. This is
 * the only absence-driven rule here, so a harness that stops sending the header has to degrade to
 * the behaviour of the day before this landed rather than take every session's live mirror down
 * with it.
 */
export function isConversationTurn(requestBody: string): boolean {
  const system = systemPromptText(requestBody);
  if (!/x-anthropic-billing-header\s*:/i.test(system)) return true;
  return /cc_prompt_id\s*=/i.test(system);
}

/** The system prompt as one string, in whichever of the two shapes the harness sent it. */
function systemPromptText(requestBody: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
  const system = (parsed as Record<string, unknown>).system;
  // A string in the simple form and an array of blocks in every flow measured; both are accepted
  // because which one the harness sends is its business and neither changes the answer.
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const value = (block as Record<string, unknown>).text;
      return typeof value === "string" ? value : "";
    })
    .join("\n");
}


/**
 * Reads tool results out of a `/v1/messages` request body. When a model calls a
 * tool, the harness runs it and then sends the NEXT request with the result as
 * a `user` message containing `tool_result` content blocks -- so the result is
 * not in the streamed response, it rides in the request of the follow-up turn.
 */
export function extractToolResults(requestBody: string): ToolResultItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const messages = (parsed as Record<string, unknown>).messages;
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const last = messages[messages.length - 1];
  if (!last || typeof last !== "object" || Array.isArray(last)) return [];
  const message = last as Record<string, unknown>;
  if (message.role !== "user") return [];
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const results: ToolResultItem[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object" || Array.isArray(part)) continue;
    const block = part as Record<string, unknown>;
    if (block.type !== "tool_result") continue;
    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    const text = toolResultText(block.content);
    if (text.length > 0 || toolUseId) results.push({ toolUseId, text });
  }
  return results;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const sub of content) {
      if (typeof sub === "string") {
        out += sub;
      } else if (sub && typeof sub === "object") {
        const s = sub as Record<string, unknown>;
        if (typeof s.text === "string") out += s.text;
      }
    }
    return out;
  }
  return "";
}

/** Reads the Anthropic identity string out of the raw body (first user_id literal). */
export function extractSessionId(requestBody: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    parsed = null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const topLevelUserId = typeof obj.user_id === "string" ? obj.user_id : null;
    const candidate = topLevelUserId ?? candidateIdentity(obj.user);
    if (candidate !== null) {
      const sessionId = sessionIdFromJsonEncodedIdentity(candidate);
      if (sessionId) return sessionId;
    }
  }
  // Fallback: the identity string does not reliably sit at the top level across
  // harness versions (it can ride inside a system block or a tool payload), so
  // find the first `user_id` string literal anywhere in the raw body, unescape
  // it as a JSON string, and read `session_id` from it.
  const match = /"user_id"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(requestBody);
  if (match) {
    let inner: string;
    try {
      inner = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return null;
    }
    return sessionIdFromJsonEncodedIdentity(inner);
  }
  return null;
}

function sessionIdFromJsonEncodedIdentity(value: string): string | null {
  let identity: unknown;
  try {
    identity = JSON.parse(value);
  } catch {
    return null;
  }
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) return null;
  const sessionId = (identity as Record<string, unknown>).session_id;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : null;
}

function candidateIdentity(user: unknown): string | null {
  if (typeof user === "string") return user;
  if (!user || typeof user !== "object") return null;
  const record = user as Record<string, unknown>;
  if (typeof record.user_id === "string") return record.user_id;
  const metadata = record.metadata;
  if (metadata && typeof metadata === "object") {
    const nested = metadata as Record<string, unknown>;
    if (typeof nested.user_id === "string") return nested.user_id;
  }
  return null;
}
