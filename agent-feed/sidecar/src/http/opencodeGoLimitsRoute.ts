// `GET /api/limits/opencode-go` -- the OpenCode Go plan meter, streamed on a route of its own.
//
// Apart from `/api/limits` on purpose. That stream is open on every machine whenever any session
// card shows a Claude or Codex meter, and the Go meter is a poll (nothing pushes it), so riding on
// it made opencode.ai get asked every couple of minutes by readers with no Go session in sight.
// Here the poll has exactly one reason to run: a panel has a Go meter mounted, which is an expanded
// opencode session card on the Go plan. The panel opens this stream with that meter and closes it
// when the card shuts; the source stops polling when the last reader leaves.

import type { LimitsStreamMessage } from "@agentdesk/agent-feed-wire";
import { createOpencodeGoSource, type OpencodeGoSource } from "@/usage/opencodeGoLimits";
import { opencodeGoPollMs, opencodeGoUsageUrl, readOpencodeGoKey } from "@/config/configOpencode";
import { encodeServerSentEvent, startServerSentEventStream } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const OPENCODE_GO_LIMITS_ROUTE = "/api/limits/opencode-go";

/** This machine's Go plan meter, read with opencode's own key and polled while a reader is here. */
function configuredSource(): OpencodeGoSource {
  return createOpencodeGoSource({ readKey: () => readOpencodeGoKey(), url: opencodeGoUsageUrl, pollMs: opencodeGoPollMs() });
}

/** The source is built here rather than in `server.ts`, whose only use of it was handing it over. */
export function createOpencodeGoLimitsRoute(source: OpencodeGoSource = configuredSource()): RouteHandler {
  return (request, url, server) => {
    if (request.method !== "GET") return undefined;
    if (url.pathname !== OPENCODE_GO_LIMITS_ROUTE) return undefined;

    return startServerSentEventStream(request, server, (write) => {
      // The same message `/api/limits` sends, carrying only this vendor, so the panel's one reader
      // handles both. No vendor at all means this machine has no Go key or no reading yet.
      const send = (): void => {
        const go = source.current();
        const message: LimitsStreamMessage = { type: "report", report: { vendors: go ? [go] : [] } };
        write(encodeServerSentEvent(message));
      };
      send();
      return source.subscribe(send);
    });
  };
}
