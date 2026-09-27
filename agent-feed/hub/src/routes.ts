// HTTP: /health open, everything else behind the Access verifier. JSON in and out, one error map.

import type { MessageAddress, PublishedBot } from "@agentdesk/agent-feed-wire";
import { Unauthorized, type Verifier } from "@/auth";
import type { Principal } from "@/config";
import { isAddress } from "@/directory";
import { Forbidden, InvalidMessage, Messages, NotFound, RateLimited, Refused, type SessionStream } from "@/messages";

const HEARTBEAT_MS = 25_000;
const MAX_BODY = 64 * 1024;

export interface RouteDeps {
  messages: Messages;
  verify: Verifier;
  log: (line: Record<string, unknown>) => void;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new InvalidMessage("request body too large");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidMessage("invalid JSON body");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidMessage("body must be a JSON object");
  return value as Record<string, unknown>;
}

function errorResponse(error: unknown, log: RouteDeps["log"], path: string): Response {
  if (error instanceof Unauthorized) return json({ error: error.message }, 401);
  if (error instanceof Forbidden) return json({ error: error.message }, 403);
  if (error instanceof NotFound) return json({ error: error.message }, 404);
  if (error instanceof Refused) return json({ error: error.message }, 409);
  if (error instanceof RateLimited) return json({ error: error.message }, 429);
  if (error instanceof InvalidMessage) return json({ error: error.message }, 400);
  log({ level: "error", path, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  return json({ error: "internal error" }, 500);
}

function openStream(deps: RouteDeps, principal: Principal, url: URL): Response {
  const sessionId = url.searchParams.get("session") ?? "";
  const channel = url.searchParams.get("channel") === "1";
  const cwd = url.searchParams.get("cwd") ?? "";
  const title = url.searchParams.get("title") ?? "";
  const encoder = new TextEncoder();
  const streamId = crypto.randomUUID();
  let address: MessageAddress | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const close = () => {
    if (heartbeat) clearInterval(heartbeat);
    if (address) deps.messages.disconnect(address, streamId);
  };
  const write = (text: string) => {
    try {
      controller?.enqueue(encoder.encode(text));
    } catch {
      close();
    }
  };
  const stream: SessionStream = {
    id: streamId,
    push: (event) => write(`data: ${JSON.stringify({ ...event, streamId })}\n\n`),
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      address = deps.messages.connect(principal, { sessionId, channel, cwd, title }, stream);
      heartbeat = setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS);
      deps.log({ event: "stream-open", address, channel, who: principal.label });
    },
    cancel() {
      deps.log({ event: "stream-close", address, who: principal.label });
      close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

async function route(deps: RouteDeps, request: Request, url: URL): Promise<Response> {
  const principal = await deps.verify(request.headers.get("cf-access-jwt-assertion"));
  const { messages } = deps;
  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/v1/stream") {
    // Validate before the stream opens, so a bad request is a status code rather than a dead stream.
    if (!principal.machine) throw new Forbidden(`${principal.label} speaks for no machine`);
    if (!/^[0-9a-f-]{36}$/.test(url.searchParams.get("session") ?? "")) throw new InvalidMessage("session must be a session uuid");
    return openStream(deps, principal, url);
  }
  if (method === "GET" && path === "/v1/directory") return json(messages.directory.list(Date.now()));
  if (method === "POST" && path === "/v1/messages") {
    const body = await readJson(request);
    return json(messages.send(principal, body), 201);
  }
  if (method === "GET" && path === "/v1/threads") {
    const as = url.searchParams.get("as");
    if (!isAddress(as)) throw new InvalidMessage("as must be an address");
    return json(messages.threadsFor(as));
  }
  if (method === "GET" && path === "/v1/inbox") {
    const as = url.searchParams.get("as");
    if (!isAddress(as)) throw new InvalidMessage("as must be an address");
    return json(messages.inbox(as));
  }
  let match = /^\/v1\/threads\/([^/]+)$/.exec(path);
  if (method === "GET" && match) return json(messages.thread(match[1]!));
  match = /^\/v1\/messages\/([^/]+)$/.exec(path);
  if (method === "GET" && match) return json(messages.get(match[1]!));
  match = /^\/v1\/messages\/([^/]+)\/delivered$/.exec(path);
  if (method === "POST" && match) {
    const body = await readJson(request);
    if (typeof body.stream !== "string") throw new InvalidMessage("stream is required");
    return json(messages.confirm(principal, match[1]!, body.stream));
  }
  match = /^\/v1\/messages\/([^/]+)\/cancel$/.exec(path);
  if (method === "POST" && match) return json(messages.cancel(principal, match[1]!));
  match = /^\/v1\/directory\/bots\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (method === "PUT" && match) {
    const body = await readJson(request);
    if (!Array.isArray(body.bots)) throw new InvalidMessage("bots must be an array");
    const bots = body.bots.map((b): PublishedBot => {
      const bot = b as Record<string, unknown>;
      if (typeof bot.botId !== "string" || typeof bot.name !== "string" || typeof bot.path !== "string" || !Array.isArray(bot.sessionIds) || !bot.sessionIds.every((s) => typeof s === "string")) {
        throw new InvalidMessage("each bot needs botId, name, path and sessionIds");
      }
      return { botId: bot.botId, name: bot.name, path: bot.path, sessionIds: bot.sessionIds as string[] };
    });
    messages.publishBots(principal, match[1]!, bots);
    return json({ ok: true, count: bots.length });
  }
  return json({ error: "not found" }, 404);
}

export function createFetch(deps: RouteDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true });
    const start = performance.now();
    let response: Response;
    try {
      response = await route(deps, request, url);
    } catch (error) {
      response = errorResponse(error, deps.log, url.pathname);
    }
    if (url.pathname !== "/v1/stream" || response.status !== 200) {
      deps.log({ method: request.method, path: url.pathname, status: response.status, ms: Math.round(performance.now() - start) });
    }
    return response;
  };
}
