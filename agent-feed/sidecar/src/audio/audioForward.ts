// The sidecar's `/api/audio/*`: passed through to the audio process, which is the only place
// listener state lives (`audioServer.ts`).
//
// Kept so an agent can go on speaking through the sidecar's address, the one it knows already.
// The phone's stream does not come this way: the panel's dev server sends it to the audio process
// directly, because a stream forwarded through here would die with every sidecar restart, which is
// what the separate process exists to stop.

import { AUDIO_HOST, audioPort } from "@/audio/audioConfig";
import { errorResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const PREFIX = "/api/audio/";

async function forward(request: Request, url: URL, port: number): Promise<Response> {
  const target = `http://${AUDIO_HOST}:${port}${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  // The audio process's own authority, not the caller's: it refuses any other Host.
  headers.set("host", `${AUDIO_HOST}:${port}`);
  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
      signal: request.signal,
      redirect: "manual",
    });
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return errorResponse(
      "audio_unreachable",
      `the audio process at ${AUDIO_HOST}:${port} did not answer: ${reason}`,
      502,
    );
  }
}

export function createAudioForward(port: number = audioPort()): RouteHandler {
  return (request, url) => (url.pathname.startsWith(PREFIX) ? forward(request, url, port) : undefined);
}
