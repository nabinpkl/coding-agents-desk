// The Claude live mirror's test fixture: a stand-in observer body server, and the observer events
// the backend ingests.
//
// Lifted out of `claudeLiveBackend.test.ts` because that file sat at exactly the 500-line cap, so
// no test could be added to it. The fixture is the half that is not about any one behaviour.

import type { ObserverEvent } from "@/live/claudeNetworkSource";

export const flush = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface FixtureServer {
  url: URL;
  stop(): void;
}

export function startFixture(): FixtureServer {
  const bodyFor = (reference: string): string => {
    if (reference === "missing") return "not-an-identity";
    if (reference === "subagent1") {
      // A subagent's request: its parent's identity, plus the harness's billing token saying whose
      // turn it really is. Both are what the wire carries.
      return JSON.stringify({
        system: [{
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.268.58f; cc_entrypoint=cli;"
            + " cc_is_subagent=true; cc_prompt_id=2a5f44c0-0db0-4745-a365-df4dadab823b;",
        }],
        user: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-b1" }),
      });
    }
    if (reference === "summariser1") {
      // A compaction summariser: the session's OWN identity, no subagent token, and a billing
      // header with no `cc_prompt_id` because there is no prompt behind it. Measured on the wire,
      // instruction and all -- the instruction is what separates it from the harness's other
      // errands, which are equally not the session speaking but are over in a second.
      return JSON.stringify({
        system: [{
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.270.d34; cc_entrypoint=cli;"
            + " cch=014d3; cc_prev_req=req_011Cf2s9jyovKWXfRAHetSU6;",
        }],
        messages: [{
          role: "user",
          content: "Your task is to create a detailed summary of the conversation so far.",
        }],
        user: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-b1" }),
      });
    }
    if (reference === "tool1") {
      return JSON.stringify({
        user: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "sess-tool1" }),
        messages: [
          { role: "user", content: "head" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "Bash", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "file.txt\nreadme.md" }] },
        ],
      });
    }
    return JSON.stringify({
      user: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: `sess-${reference}` }),
    });
  };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/v1/bodies/")) {
        const reference = url.pathname.slice("/v1/bodies/".length);
        return new Response(bodyFor(reference), { headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  // `server.port` is assigned after `serve` returns.
  return {
    url: new URL(`http://127.0.0.1:${(server as { port: number }).port}`),
    stop: () => server.stop(true),
  };
}

export function flowEvent(
  flowId: string,
  path: string,
  authority: string,
  bodyRef?: string,
  requestHeaders?: { name: string; value: string }[],
  /** When the API began the request. The observer reports it on every flow. */
  startedAt?: string,
): ObserverEvent {
  return {
    observedAt: new Date().toISOString(),
    flowUpserted: {
      flow: {
        flowId,
        protocol: "OBSERVED_PROTOCOL_SSE",
        path,
        authority,
        ...(bodyRef ? { requestBody: { value: bodyRef } } : {}),
        ...(requestHeaders ? { requestHeaders } : {}),
        ...(startedAt ? { startedAt } : {}),
      },
    },
  };
}

/** The beta list a 1M run actually sends, trimmed; the real one carries a dozen more entries. */
export const LONG_CONTEXT_BETAS = {
  name: "anthropic-beta",
  value: "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07,interleaved-thinking-2025-05-14",
};
export const ORDINARY_BETAS = {
  name: "anthropic-beta",
  value: "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
};

export function delta(flowId: string, payload: unknown): ObserverEvent {
  return {
    observedAt: new Date().toISOString(),
    streamDeltaObserved: {
      flowId,
      sequence: "1",
      eventType: "message",
      data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
    },
  };
}

export function ended(flowId: string): ObserverEvent {
  return { observedAt: new Date().toISOString(), streamEnded: { flowId } };
}

