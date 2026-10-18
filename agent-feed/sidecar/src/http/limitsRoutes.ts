// `GET /api/limits` -- the live rate-limit meters, streamed, and nothing else.
//
// The same readings `/api/usage` carries on every vendor, split onto a route of their own because
// the two questions have different costs. A report means sweeping every transcript this machine
// has ever written; the meters mean reading two small files, or none at all once a response has
// crossed the proxy.
//
// A stream rather than a plain body, and not for the reason `/api/usage` is one. That stream is
// finite: it has a slow half to wait for, sends cache then sweep, and closes. This one is endless
// and exists because the sidecar is already TOLD when the numbers move -- proxy-agent's observer
// hands over the response headers as each Anthropic call comes back, which is what
// `claudeLiveQuota` folds into a reading. A panel that polled this would be asking on a timer for
// something the sidecar knew milliseconds after the request finished, and would be at its most
// stale in the seconds after a turn is sent, which is exactly when a reader looks.
//
// Codex is the asymmetry worth naming: its meter is stamped on rollout records rather than
// published on a header, so it rides on the last completed sweep and moves when that does. This
// route never sweeps to find out.

import type { LimitsStreamMessage } from "@agentdesk/agent-feed-wire";
import { onLiveQuotaChange } from "@/usage/claudeLiveQuota";
import { createUsageScanner, readVendorQuotas, type UsageScanner, type UsageVendorPaths } from "@/usage/usageReport";
import { encodeServerSentEvent, startServerSentEventStream } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const LIMITS_ROUTE = "/api/limits";

export function createLimitsRoutes(
  scanner: UsageScanner = createUsageScanner(),
  /** Overridden only by tests, which must not read the developer's own `~/.claude.json`. */
  paths: Partial<UsageVendorPaths> = {},
): RouteHandler {
  return (request, url, server) => {
    if (request.method !== "GET") return undefined;
    if (url.pathname !== LIMITS_ROUTE) return undefined;

    return startServerSentEventStream(request, server, (write) => {
      let open = true;
      // One report at a time, in the order they were asked for. Reading the meters is async, so
      // two responses landing together would otherwise race and could leave the OLDER reading
      // written last -- a meter that went backwards under a reader watching it climb.
      let tail: Promise<void> = Promise.resolve();
      const send = (): void => {
        tail = tail.then(async () => {
          if (!open) return;
          const message = await report(scanner, paths);
          if (open) write(encodeServerSentEvent(message));
        });
      };

      // The reading it already has, so a card that opens between two responses paints at once
      // rather than sitting empty until the next request happens to come back.
      send();
      const unsubscribe = onLiveQuotaChange(send);
      return () => {
        open = false;
        unsubscribe();
      };
    });
  };
}

async function report(scanner: UsageScanner, paths: Partial<UsageVendorPaths>): Promise<LimitsStreamMessage> {
  try {
    // The scanner's LAST completed report, never a new sweep: Codex's meter comes from there, and
    // a machine whose modal has not been opened reports no Codex meter rather than paying for a
    // sweep nobody asked for.
    return { type: "report", report: await readVendorQuotas(paths, scanner.cached()) };
  } catch (error) {
    return {
      type: "error",
      error: {
        code: "limits-read-failed",
        message: error instanceof Error ? error.message : String(error),
        // Retryable: what fails here is reading a file another process is writing, and the next
        // response across the proxy asks again by itself.
        retryable: true,
      },
    };
  }
}
