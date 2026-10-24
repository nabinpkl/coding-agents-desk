// Web push routes: the panel fetches the public key, hands back the subscription its browser made,
// and asks for a test push.
//
//   GET  /api/push/key            -> { publicKey }
//   POST /api/push/subscriptions  <- PushSubscription.toJSON()
//   POST /api/push/test           -> { sent: [{ host, status, gone }] }
//
// A subscription's endpoint is a URL this sidecar will later POST to, so only the browsers' own push
// services are accepted: anything else would let a request aim the sidecar at an arbitrary host.

import { hostname } from "node:os";
import {
  PUSH_KEY_ROUTE,
  PUSH_SUBSCRIPTIONS_ROUTE,
  PUSH_TEST_ROUTE,
  type PushKeyResponse,
  type PushTestResponse,
} from "@agentdesk/agent-feed-wire";
import { errorResponse, jsonResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";
import { pushToAll, type PushSend } from "@/push/pushFanout";
import type { PushPayload } from "@/push/pushSender";
import { addSubscription, ensureVapidKeys, parseSubscription } from "@/push/pushStore";

/** Apple (Safari and Home Screen web apps), Google (Chrome), Mozilla, Microsoft. */
const PUSH_SERVICE_HOSTS = ["push.apple.com", "fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com"];

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return PUSH_SERVICE_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
}

export type PushRouteOptions = {
  path: string;
  subject: string;
  send: PushSend;
  now?: () => Date;
};

async function subscribe(request: Request, options: PushRouteOptions): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid_subscription", "body is not JSON", 400);
  }
  const subscription = parseSubscription(body);
  if (!subscription) return errorResponse("invalid_subscription", "expected { endpoint, keys: { p256dh, auth } }", 400);
  if (!isPushServiceEndpoint(subscription.endpoint)) {
    return errorResponse("invalid_subscription", "endpoint is not a known push service", 400);
  }
  await addSubscription(options.path, subscription, (options.now ?? (() => new Date()))());
  return new Response(null, { status: 204 });
}

async function sendTest(options: PushRouteOptions): Promise<Response> {
  const payload: PushPayload = {
    title: "AgentDesk",
    body: `Test notification from ${hostname()}`,
    url: "/?entry=feed&view=canvas",
    tag: "push-test",
  };
  const outcomes = await pushToAll(options.path, payload, options.subject, options.send);
  if (outcomes.length === 0) {
    return errorResponse("no_subscriptions", "no device has allowed notifications yet", 409);
  }
  const answer: PushTestResponse = {
    sent: outcomes.map((outcome) => ({
      host: new URL(outcome.endpoint).host,
      status: outcome.status,
      gone: outcome.gone,
    })),
  };
  return jsonResponse(answer);
}

export function createPushRoutes(options: PushRouteOptions): RouteHandler {
  return (request, url) => {
    if (url.pathname === PUSH_KEY_ROUTE && request.method === "GET") {
      return ensureVapidKeys(options.path).then((vapid) =>
        jsonResponse({ publicKey: vapid.publicKey } satisfies PushKeyResponse),
      );
    }
    if (url.pathname === PUSH_SUBSCRIPTIONS_ROUTE && request.method === "POST") return subscribe(request, options);
    if (url.pathname === PUSH_TEST_ROUTE && request.method === "POST") return sendTest(options);
    return undefined;
  };
}
