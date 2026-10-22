// The ask_owner routes: the process serving the tool waits here, and the panel watches and answers.
//
// - `POST /api/asks`: a call is waiting. The response is a stream that stays open, with heartbeats,
//   until the owner answers or dismisses it, then carries the verdict and ends. The request is the
//   call's lifeline: when the serving process goes, so does the call.
// - `GET /api/sessions/{source}/{sessionId}/asks/stream`: what that session is waiting on, whole,
//   on opening and on every change.
// - `POST /api/sessions/{source}/{sessionId}/asks/{toolUseId}/answer` and `.../dismiss`: 200 with
//   an `AskOwnerOutcome`, a refusal included, because "nothing is waiting under that id" is a fact
//   the panel shows beside the question rather than a malformed request.

import type { AskOwnerVerdict, SourceId } from "@agentdesk/agent-feed-wire";
import {
  encodeServerSentEvent,
  errorResponse,
  jsonResponse,
  startServerSentEventStream,
} from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import type { AskOwnerWaits } from "@/asks/askOwnerWaits";
import { readWaitCommand } from "@/asks/askOwnerShape";

const SESSION_ASKS =
  /^\/api\/sessions\/(claude|opencode)\/([A-Za-z0-9._:-]{1,128})\/asks\/(?:(stream)|([A-Za-z0-9_-]{1,128})\/(answer|dismiss))$/;

export function createAskOwnerRoutes(waits: AskOwnerWaits): RouteHandler {
  return (request, url, server) => {
    if (url.pathname === "/api/asks") {
      if (request.method !== "POST") return undefined;
      return waitForVerdict(waits, request, server);
    }
    const match = SESSION_ASKS.exec(url.pathname);
    if (!match) return undefined;
    const [, source, sessionId, stream, toolUseId, action] = match as unknown as [
      string,
      SourceId,
      string,
      string | undefined,
      string | undefined,
      "answer" | "dismiss" | undefined,
    ];
    if (stream) {
      if (request.method !== "GET") return undefined;
      return startServerSentEventStream(request, server, (write) =>
        waits.observe(source, sessionId, (asks) => write(encodeServerSentEvent({ asks }))),
      );
    }
    if (request.method !== "POST" || !toolUseId) return undefined;
    if (action === "dismiss") return jsonResponse(waits.dismiss(source, sessionId, toolUseId));
    return answer(waits, request, source, sessionId, toolUseId);
  };
}

async function waitForVerdict(
  waits: AskOwnerWaits,
  request: Request,
  server: Parameters<RouteHandler>[2],
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid-body", "the request body was not JSON", 400);
  }
  const command = readWaitCommand(body);
  if (!command.ok) return errorResponse("ask-invalid", command.message, 400);
  const { toolUseId, source, sessionId, questions } = command.value;
  console.info(
    JSON.stringify({
      event: "agent-feed-ask-owner-waiting",
      toolUseId,
      source,
      sessionId,
      questions: questions.length,
    }),
  );
  return startServerSentEventStream(request, server, (write, close) =>
    waits.wait(command.value, (verdict: AskOwnerVerdict) => {
      console.info(
        JSON.stringify({
          event: "agent-feed-ask-owner-settled",
          toolUseId,
          how: "answered" in verdict ? "answered" : "dismissed",
        }),
      );
      write(encodeServerSentEvent(verdict));
      close();
    }),
  );
}

async function answer(
  waits: AskOwnerWaits,
  request: Request,
  source: SourceId,
  sessionId: string,
  toolUseId: string,
): Promise<Response> {
  let body: { answers?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return errorResponse("invalid-body", "the request body was not JSON", 400);
  }
  return jsonResponse(waits.answer(source, sessionId, toolUseId, body.answers));
}
