// `GET /api/usage` -- per-day token usage across every vendor whose records are on this machine.
//
// Not under `/api/sessions/`: usage is a fact about the machine, not about a thread, and it is
// read from files no session in the panel necessarily has open.
//
// A stream rather than a JSON body because the honest answer arrives in two parts. The cache can
// be served in microseconds and the sweep behind it takes seconds on a cold cache; a plain GET
// would have to pick one of "instant but possibly stale" and "correct but seemingly hung". This
// sends both, in that order, and closes -- so a warm open paints immediately and still corrects
// itself if today's sessions have grown since.

import type { UsageStreamMessage } from "@agentdesk/agent-feed-wire";
import { createUsageScanner, type UsageScanner } from "../usage/usageReport.ts";
import { encodeServerSentEvent, startServerSentEventStream } from "./httpResponses.ts";
import type { RouteHandler } from "./route.ts";

const USAGE_ROUTE = "/api/usage";

export function createUsageRoutes(scanner: UsageScanner = createUsageScanner()): RouteHandler {
  return (request, url, server) => {
    if (request.method !== "GET") return undefined;
    if (url.pathname !== USAGE_ROUTE) return undefined;

    return startServerSentEventStream(request, server, (write, close) => {
      let open = true;
      const send = (message: UsageStreamMessage): void => {
        if (open) write(encodeServerSentEvent(message));
      };

      const cached = scanner.cached();
      if (cached) send({ type: "report", report: cached });

      void scanner.scan().then(
        (report) => {
          // Suppressed when it is the very object already sent: the sweep found nothing new, and
          // a second identical report would re-render the modal for no reason. The scanner
          // returns its previous object in that case, so identity is the whole test.
          if (report !== cached) send({ type: "report", report });
          send({ type: "settled" });
          close();
        },
        (error: unknown) => {
          send({
            type: "error",
            error: {
              code: "usage-scan-failed",
              message: error instanceof Error ? error.message : String(error),
              // Retryable: what fails here is reading files that another process is writing, and
              // asking again is a reasonable answer to all of it.
              retryable: true,
            },
          });
          close();
        },
      );

      return () => {
        open = false;
      };
    });
  };
}
