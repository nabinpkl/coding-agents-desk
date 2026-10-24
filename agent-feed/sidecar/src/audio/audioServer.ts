// The audio process: the channel's streams, noise beds and listening devices, in a process of its
// own so a listener outlives the sidecar.
//
// The sidecar is replaced on every save anywhere in its tree, and a stream it served died with it,
// mid-sentence, on every peer's edit. This process is replaced only when a file it is built from
// changes (the supervisor computes which, from this file's imports), so it imports as little as it
// can manage: the audio code, the wire's shapes and the request guard.
//
// It is the one home of listener state. The sidecar forwards `/api/audio/*` here rather than
// keeping a copy (`audioForward.ts`), and the panel's dev server sends the phone's stream here
// directly, so a sidecar restart is not in the stream's path at all.

import { AUDIO_HOST, audioPort } from "@/audio/audioConfig";
import { createAudioRoutes } from "@/audio/audioStream";
import { errorResponse } from "@/http/protocol/httpResponses";
import { refuseForeignRequest } from "@/http/protocol/requestGuard";

/** Who may address this process: loopback by either name. The sidecar and the dev server use the first. */
const ALLOWED_HOSTS = new Set([AUDIO_HOST, "localhost"]);

const routes = createAudioRoutes();

const server = Bun.serve<undefined>({
  hostname: AUDIO_HOST,
  port: audioPort(),
  // A stream is supposed to run for hours, and Bun counts a streaming response as idle and closes
  // it after ten seconds by default. 0 turns that off, as on the sidecar.
  idleTimeout: 0,
  async fetch(request, bunServer) {
    // Loopback is not a boundary to the owner's own browser: another site's page can still send
    // this port a request, and a rebound name can read the answer. Refused as the sidecar refuses.
    const refusal = refuseForeignRequest(request, ALLOWED_HOSTS);
    if (refusal) return refusal;
    const url = new URL(request.url);
    const answer = await routes(request, url, bunServer);
    return (
      answer ??
      errorResponse("route-not-found", `the audio process has no route ${request.method} ${url.pathname}`, 404)
    );
  },
});

console.log(`[audio] listening on ${AUDIO_HOST}:${server.port}`);

function shutdown(signal: string): void {
  console.log(`[audio] ${signal}; stopping`);
  // Closed at once, streams included: a listener's player reconnects to whichever process is next.
  void server.stop(true).finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
