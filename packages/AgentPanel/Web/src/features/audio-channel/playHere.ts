// A reply played on this device, through its own output (`SpeakHereButton`): the Mac makes the
// speech, since only it has the voice, and streams it back as it is made (`POST /api/speech/here`),
// and this plays it through Web Audio. Not Agent Radio: nobody else hears it, and it neither waits
// for nor stops what Agent Radio is saying.
//
// The context is made in the tap that asked, before anything is awaited, because iOS lets a page's
// audio start only inside a gesture. Each piece is scheduled straight after the one before, so the
// pieces play as one; the Mac makes speech several times faster than it plays, so after the first
// piece the rest arrive well ahead of playback.
//
// One at a time on a page: playing another stops this one. A stop drops what is scheduled at once,
// by closing the context, and tells the Mac to stop making the rest, since the sidecar is never told
// that a page hung up.

import { SPEECH_HERE_ROUTE, SPEECH_HERE_STOP_ROUTE, SPEECH_SAMPLE_RATE } from "@agentdesk/agent-feed-wire";

export type HereOutcome = { state: "played" } | { state: "stopped" } | { state: "failed"; reason: string };

export type HerePlayback = {
  /** Stops it, wherever it is; nothing when it has already finished. */
  stop(): void;
  /** What became of it, once it has finished, been stopped, or failed. */
  finished: Promise<HereOutcome>;
};

/** Pieces are scheduled once they hold this much: one of the Mac's 80 ms frames. */
const PIECE_BYTES = (SPEECH_SAMPLE_RATE / 1000) * 80 * Float32Array.BYTES_PER_ELEMENT;

/** How far ahead of now the first piece, or one after a gap, is started, so it starts whole. */
const START_LEAD_S = 0.03;

type SessionNavigator = Navigator & { audioSession?: { type: string } };

let current: HerePlayback | null = null;

function newRef(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

async function failureOf(response: Response): Promise<string> {
  const failure = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (failure?.error?.code === "nothing_to_say") return "nothing in it can be read out loud";
  return failure?.error?.message ?? `the sidecar answered ${response.status}`;
}

function joined(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.length === 0) return tail;
  const both = new Uint8Array(head.length + tail.length);
  both.set(head);
  both.set(tail, head.length);
  return both;
}

export function playHere(text: string, makeContext: () => AudioContext = () => new AudioContext()): HerePlayback {
  current?.stop();
  // iOS plays a page's Web Audio through the ring/silent switch unless it is told this is playback.
  const session = (navigator as SessionNavigator).audioSession;
  if (session && session.type !== "play-and-record") session.type = "playback";
  const context = makeContext();
  void context.resume().catch(() => undefined);
  const ref = newRef();
  const abort = new AbortController();
  let settle: (outcome: HereOutcome) => void = () => {};
  const finished = new Promise<HereOutcome>((resolve) => (settle = resolve));
  let over = false;
  let allMade = false;

  const end = (outcome: HereOutcome) => {
    if (over) return;
    over = true;
    if (current === playback) current = null;
    abort.abort();
    void context.close().catch(() => undefined);
    settle(outcome);
  };

  const playback: HerePlayback = {
    finished,
    stop() {
      if (over) return;
      if (!allMade) {
        void fetch(SPEECH_HERE_STOP_ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref }),
        }).catch(() => undefined);
      }
      end({ state: "stopped" });
    },
  };
  current = playback;

  let playsUntil = 0;
  let last: AudioBufferSourceNode | null = null;
  const schedule = (bytes: Uint8Array) => {
    // Copied, so the samples start on a four-byte boundary whatever the network split.
    const samples = new Float32Array(bytes.slice().buffer);
    const buffer = context.createBuffer(1, samples.length, SPEECH_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const at = Math.max(playsUntil, context.currentTime + START_LEAD_S);
    source.start(at);
    playsUntil = at + buffer.duration;
    last = source;
  };

  const stream = async () => {
    const response = await fetch(SPEECH_HERE_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, ref }),
      signal: abort.signal,
    });
    if (!response.ok || !response.body) {
      allMade = true;
      end({ state: "failed", reason: await failureOf(response) });
      return;
    }
    const reader = response.body.getReader();
    let pending: Uint8Array = new Uint8Array(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (over) return;
      if (value) pending = joined(pending, value);
      if (pending.length >= PIECE_BYTES || (done && pending.length >= Float32Array.BYTES_PER_ELEMENT)) {
        const whole = pending.length - (pending.length % Float32Array.BYTES_PER_ELEMENT);
        schedule(pending.subarray(0, whole));
        pending = pending.slice(whole);
      }
      if (done) break;
    }
    allMade = true;
    const final = last;
    if (!final) end({ state: "failed", reason: "the Mac sent no speech" });
    else if (context.currentTime >= playsUntil) end({ state: "played" });
    else final.onended = () => end({ state: "played" });
  };

  stream().catch((error: unknown) => {
    if (!over) end({ state: "failed", reason: error instanceof Error ? error.message : String(error) });
  });
  return playback;
}
