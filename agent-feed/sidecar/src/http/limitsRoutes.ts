// `GET /api/limits` -- the live rate-limit meters, and nothing else.
//
// The same readings `/api/usage` carries on every vendor, split onto a route of their own because
// the two questions have different costs. A report means sweeping every transcript this machine
// has ever written; the meters mean reading two small files. The context readout's detail popover
// asks only the second question, several times a session, and opening the whole sweep to answer
// it would spend gigabytes on one row.
//
// A plain JSON body rather than a stream, for the same reason: there is no slow half to wait for.

import type { QuotaReport } from "@agentdesk/agent-feed-wire";
import {
  createUsageScanner,
  readVendorQuotas,
  type UsageScanner,
  type UsageVendorPaths,
} from "@/usage/usageReport";
import { jsonResponse } from "@/http/httpResponses";
import type { RouteHandler } from "@/http/route";

const LIMITS_ROUTE = "/api/limits";

export function createLimitsRoutes(
  scanner: UsageScanner = createUsageScanner(),
  /** Overridden only by tests, which must not read the developer's own `~/.claude.json`. */
  paths: Partial<UsageVendorPaths> = {},
): RouteHandler {
  return (request, url) => {
    if (request.method !== "GET") return undefined;
    if (url.pathname !== LIMITS_ROUTE) return undefined;

    // The scanner's LAST completed report, never a new sweep. It is where Codex's meter comes
    // from, since that one is stamped on rollout records rather than published in a file of its
    // own; a machine whose modal has not been opened yet reports no Codex meter rather than
    // paying for a sweep nobody asked for.
    return readVendorQuotas(paths, scanner.cached())
      .then((report: QuotaReport) => jsonResponse(report));
  };
}
