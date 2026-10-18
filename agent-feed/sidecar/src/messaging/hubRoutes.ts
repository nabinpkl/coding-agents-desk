// The panel's way into the agent messaging hub. The panel never holds the hub token: this sidecar
// does, and speaks as `human` on the panel's behalf, which is the same trust the panel already has
// over this machine's sessions.

import type { DirectoryEntry, Message } from "@agentdesk/agent-feed-wire";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import { HubClient, HubError, loadHubSettings } from "@/messaging/hubClient";

const MAXIMUM_BODY_BYTES = 64 * 1024;

export interface HubStatus {
  configured: boolean;
  machine: string | null;
  /** Why the hub is not usable from here, when it is not. */
  reason: string | null;
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAXIMUM_BODY_BYTES) throw new HubError(413, "message too large");
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Falls through to the same refusal as a non-object.
  }
  throw new HubError(400, "body must be a JSON object");
}

function failure(error: unknown): Response {
  if (error instanceof HubError) return errorResponse("hub", error.message, error.status);
  return errorResponse("hub-unreachable", error instanceof Error ? error.message : String(error), 502);
}

export function createHubRoutes(
  load: () => HubClient | string = () => {
    const settings = loadHubSettings();
    return typeof settings === "string" ? settings : new HubClient(settings);
  },
): RouteHandler {
  return (request, url) => {
    if (!url.pathname.startsWith("/api/hub/")) return undefined;
    // Read per request, so a token written after the sidecar started is picked up without a restart.
    const hub = load();
    if (request.method === "GET" && url.pathname === "/api/hub/status") {
      const status: HubStatus =
        typeof hub === "string"
          ? { configured: false, machine: null, reason: hub }
          : { configured: true, machine: hub.settings.machine, reason: null };
      return jsonResponse(status);
    }
    if (typeof hub === "string") return errorResponse("hub-unconfigured", hub, 503);
    return handle(hub, request, url).catch(failure);
  };
}

async function handle(hub: HubClient, request: Request, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/hub/directory") {
    return jsonResponse(await hub.request<DirectoryEntry[]>("GET", "/v1/directory"));
  }
  if (request.method === "GET" && url.pathname === "/api/hub/threads") {
    return jsonResponse(await hub.request<Message[][]>("GET", "/v1/threads?as=human"));
  }
  if (request.method === "POST" && url.pathname === "/api/hub/messages") {
    const body = await readBody(request);
    const payload =
      typeof body.inReplyTo === "string"
        ? { as: "human", inReplyTo: body.inReplyTo, body: body.body }
        : { as: "human", to: body.to, kind: body.kind, body: body.body };
    return jsonResponse(await hub.request<Message>("POST", "/v1/messages", payload), 201);
  }
  const cancel = /^\/api\/hub\/messages\/([^/]+)\/cancel$/.exec(url.pathname);
  if (request.method === "POST" && cancel) {
    return jsonResponse(await hub.request<Message>("POST", `/v1/messages/${encodeURIComponent(cancel[1]!)}/cancel`));
  }
  return errorResponse("not-found", "no such hub route", 404);
}
