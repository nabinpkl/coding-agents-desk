import { sessionApiPrefix } from "@/app/panelSessions";
import type { AgentHttpTransport, SubscribeHandlers, TransportResponse } from "@/features/activity-feed/transport/AgentHttpTransport";

/**
 * The same sidecar path, addressed at one particular login session.
 *
 * Only `/api` moves. Anything else a caller asks for belongs to the page's own origin and is not a
 * sidecar call, so redirecting it would break it.
 */
export function sessionPath(sessionId: string | undefined, path: string): string {
  if (!sessionId || !path.startsWith("/api")) return path;
  return sessionApiPrefix(sessionId) + path.slice("/api".length);
}

/**
 * A transport pointed at another login session.
 *
 * Wrapping rather than threading a session id through the viewer is what keeps the desktop code
 * ignorant of sessions entirely: it asks for `/api/...` as it always did, and which machine-session
 * answers is decided once, here. The default session returns the transport untouched, so the
 * relay path inside the host's webview is bit-for-bit what it was.
 */
export function sessionTransport(
  base: AgentHttpTransport,
  sessionId?: string,
): AgentHttpTransport {
  if (!sessionId) return base;
  const resourceUrl = base.resourceUrl?.bind(base);
  return {
    request(method: string, path: string, options?: { body?: unknown; signal?: AbortSignal }): Promise<TransportResponse> {
      return base.request(method, sessionPath(sessionId, path), options);
    },
    subscribe(path: string, handlers: SubscribeHandlers): () => void {
      return base.subscribe(sessionPath(sessionId, path), handlers);
    },
    // Only where the base has one: a wrapper that invented an address would hand a relayed page a
    // URL nothing answers.
    ...(resourceUrl
      ? { resourceUrl: (path: string) => resourceUrl(sessionPath(sessionId, path)) }
      : {}),
  };
}
