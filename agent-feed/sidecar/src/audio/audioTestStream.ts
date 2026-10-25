// An hour-long test of the spoken audio channel: does a phone keep playing a live stream, locked?
//
//   GET /api/audio/test-stream            -> audio/aac, one hour, paced in real time
//   GET /api/audio/test-stream?from=<ms>  -> the same hour, joined that far in
//
// Every five seconds it says how far into the stream it is ("12 minutes 35"), with silence between.
// Each line is spoken just before its turn rather than all at the start, the way a forwarded agent
// message will be, and the stream is paced so the phone cannot buffer ahead: what it plays at
// minute twelve was made at minute twelve. A listener who hears the count skip, or fall behind the
// clock, has heard the stream stall.
//
// `from` is how a listener comes back after a pause or after another app took the audio: it joins
// where the stream is now, not where it stopped, as a live channel would. The count it then speaks
// is still the time since the test began, so the gap is heard rather than hidden.

import { AUDIO_TEST_STREAM_ROUTE } from "@agentdesk/agent-feed-wire";
import { splitAdtsFrames, type AdtsFrame } from "@/audio/adtsFrames";
import { speakToAdts } from "@/audio/speechAudio";
import { errorResponse } from "@/http/protocol/httpResponses";
import type { RouteHandler } from "@/http/protocol/route";

const LENGTH_MS = 60 * 60_000;
const LINE_EVERY_MS = 5_000;

/**
 * Sent ahead of the clock, so playback starts soon and a late wake-up does not run it dry. Chrome
 * waits for a few seconds of a stream before it starts: with 2s sent ahead it started after about
 * six seconds of waiting.
 */
const LEAD_MS = 6_000;

/** How far ahead of its turn a line is spoken. `say` takes about a second for a short line. */
const SPEAK_AHEAD_MS = 10_000;

/** The longest the pacer sleeps; a frame lasts 46ms, so this sends five or so at a time. */
const TICK_MS = 250;

/** What line `index` says: the stream position it plays at. */
export function lineText(index: number): string {
  if (index === 0) return "Hour long audio test. A line every five seconds.";
  const seconds = (index * LINE_EVERY_MS) / 1000;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest} seconds`;
  const minutesSaid = minutes === 1 ? "1 minute" : `${minutes} minutes`;
  return rest === 0 ? minutesSaid : `${minutesSaid} ${rest}`;
}

/**
 * One frame from the middle of half a second of encoded silence, repeated for every gap: the same
 * encoder and settings as the speech, so the decoder never sees the stream change shape. Made once
 * per process; a failure is dropped so the next stream tries again.
 */
let silenceFrame: Promise<AdtsFrame> | null = null;
function silence(): Promise<AdtsFrame> {
  if (silenceFrame) return silenceFrame;
  const making = speakToAdts("[[slnc 500]]").then((bytes) => {
    const frames = splitAdtsFrames(bytes);
    const middle = frames[Math.floor(frames.length / 2)];
    if (!middle) throw new Error("say produced no frames for silence");
    return middle;
  });
  silenceFrame = making;
  making.catch(() => (silenceFrame = null));
  return making;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}

/**
 * The hour, made as it goes: silence, and a line at every `LINE_EVERY_MS` of stream position.
 *
 * `clockMs` is the stream position of the next frame to send. A frame goes out once the wall clock,
 * plus the lead, reaches it. Lines are spoken `SPEAK_AHEAD_MS` before their turn, and one that is
 * still being spoken when its turn comes holds the stream until it is ready, which the lead covers.
 * A line that runs past the next one's turn pushes that one back; the turn after is on time again.
 */
function pacedStream(gap: AdtsFrame, fromMs: number, label: string, stopped: AbortSignal): ReadableStream<Uint8Array> {
  // The wall-clock moment stream position 0 had, or would have had for a listener joining late.
  let startedAt = 0;
  let connectedAt = 0;
  // Joined on a frame boundary, and at the first line still to come.
  let clockMs = Math.floor(fromMs / gap.durationMs) * gap.durationMs;
  let nextLine = Math.ceil(clockMs / LINE_EVERY_MS);
  const speaking = new Map<number, Promise<AdtsFrame[]>>();
  const lineAt = (index: number) => index * LINE_EVERY_MS;
  const speakUpTo = (untilMs: number) => {
    for (let index = nextLine; lineAt(index) < LENGTH_MS && lineAt(index) <= untilMs; index += 1) {
      if (speaking.has(index)) continue;
      const line = speakToAdts(lineText(index)).then(splitAdtsFrames);
      // Handled here as well as where its turn awaits it: a line that fails while it waits, or
      // waits for a listener who has left, would otherwise be an unhandled rejection, which takes
      // the whole sidecar down. Its turn still awaits it, and a failure there ends the stream.
      line.catch(() => {});
      speaking.set(index, line);
    }
  };
  let finished = false;
  const finish = (how: string) => {
    if (finished) return;
    finished = true;
    console.log(
      `[audio] ${label}: ${how} after ${seconds(Date.now() - connectedAt)}, at stream position ${seconds(clockMs)}`,
    );
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      connectedAt = Date.now();
      startedAt = connectedAt - clockMs;
      console.log(`[audio] ${label}: started at stream position ${seconds(clockMs)}`);
      // The listener leaving, as either side reports it: Bun cancels the stream, or the request's
      // signal aborts. Whichever comes first stops lines being spoken for nobody.
      stopped.addEventListener("abort", () => {
        finish("listener left (request aborted)");
        try {
          controller.close();
        } catch {
          // Already closed or cancelled: the other report got there first.
        }
      });
    },
    async pull(controller) {
      // A poll on the clock, justified: what decides when the next frame is due is time itself,
      // and nothing else could announce it. Pull-driven, so a reader that stops pulling stops it.
      for (;;) {
        if (finished) return;
        if (clockMs >= LENGTH_MS) {
          finish("sent to the end");
          controller.close();
          return;
        }
        const dueMs = Date.now() - startedAt + LEAD_MS;
        if (clockMs > dueMs) {
          await Bun.sleep(Math.max(1, Math.min(TICK_MS, clockMs - dueMs)));
          continue;
        }
        const chunk: Uint8Array[] = [];
        while (clockMs <= dueMs && clockMs < LENGTH_MS) {
          speakUpTo(clockMs + SPEAK_AHEAD_MS);
          const line = clockMs >= lineAt(nextLine) ? speaking.get(nextLine) : undefined;
          if (line) {
            speaking.delete(nextLine);
            nextLine += 1;
            for (const frame of await line) {
              chunk.push(frame.bytes);
              clockMs += frame.durationMs;
            }
          } else {
            chunk.push(gap.bytes);
            clockMs += gap.durationMs;
          }
        }
        if (finished) return;
        controller.enqueue(concat(chunk));
        return;
      }
    },
    cancel() {
      finish("listener left (stream cancelled)");
    },
  });
}

async function serveTestStream(request: Request, url: URL): Promise<Response> {
  const from = url.searchParams.get("from");
  const fromMs = from === null ? 0 : Number(from);
  if (!Number.isFinite(fromMs) || fromMs < 0) {
    return errorResponse("invalid_from", "from must be a non-negative number of milliseconds", 400);
  }
  if (fromMs >= LENGTH_MS) return errorResponse("test_over", "the hour-long test has ended", 410);
  let gap: AdtsFrame;
  try {
    gap = await silence();
  } catch (error) {
    return errorResponse("speech_failed", error instanceof Error ? error.message : String(error), 500);
  }
  // Which reader this is, for the log: a phone opens the same stream more than once while it probes.
  const label = `test stream ${request.headers.get("range") ?? "no range"} ${request.headers.get("user-agent")?.slice(0, 60) ?? ""}`;
  return new Response(pacedStream(gap, fromMs, label, request.signal), {
    headers: { "content-type": "audio/aac", "cache-control": "no-store" },
  });
}

export function createAudioRoutes(): RouteHandler {
  return (request, url) => {
    if (url.pathname === AUDIO_TEST_STREAM_ROUTE && request.method === "GET") return serveTestStream(request, url);
    return undefined;
  };
}
