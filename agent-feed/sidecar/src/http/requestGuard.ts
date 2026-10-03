// Who may ask the sidecar anything, checked ahead of every route.
//
// The control API carries no token because the tailnet is the trust boundary (`server.ts`). That
// holds against other machines and not against the owner's own browser, which does not treat
// loopback as a boundary. Any page open in it can send this port requests: a `text/plain` POST
// needs no preflight, and the routes read their JSON bodies whatever the Content-Type says. And a
// page whose name an attacker re-points at 127.0.0.1 (DNS rebinding) is same-origin with the
// sidecar, so it can read every answer, session ids included, and then type into a session.
//
// Two checks close both:
//
// - The Host must be one `config.allowedHosts` names. The panel's proxy addresses the sidecar by
//   its own authority (`sidecarProxy.ts` rewrites Host to the upstream's), and the host's clients
//   dial loopback, so both pass. A rebound page still sends its own name, and is refused.
// - A request another site's page made is refused. The browser states it in Sec-Fetch-Site and a
//   page cannot forge it. The panel's requests are same-origin and the proxy forwards the header;
//   the host's own clients send none. Another port on the same name counts as another site.

import { errorResponse } from "@/http/httpResponses";

/** The refusal for a request that must not reach a route, or null to let it through. */
export function refuseForeignRequest(
  request: Request,
  allowedHosts: ReadonlySet<string>,
): Response | null {
  const host = new URL(request.url).hostname;
  if (!allowedHosts.has(host)) {
    return errorResponse("host-not-allowed", `host not allowed: ${host}`, 400);
  }
  const fetchedBy = request.headers.get("sec-fetch-site");
  if (fetchedBy === "cross-site" || fetchedBy === "same-site") {
    return errorResponse("foreign-site", `refused a ${fetchedBy} request`, 403);
  }
  return null;
}
