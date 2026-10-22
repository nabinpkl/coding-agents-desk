"use client";

import { useRef, useState } from "react";
import { Radio, Square } from "lucide-react";
import { SPEECH_READ_ROUTE, SPEECH_STOP_ROUTE, type SpeechReadResponse } from "@agentdesk/agent-feed-wire";
import { replyAudioButtonClass } from "@/features/audio-channel/replyAudioButtonClass";

/**
 * The broadcast button at the end of an agent's reply: reads it out loud on this Mac's speech
 * process, to whoever listens on Agent Radio (`POST /api/speech/read`), not on this device; the
 * speaker beside it does that (`SpeakHereButton`). The sidecar leaves out the reply's report blocks
 * and queues it with the sessions' own announcements, so it is heard in turn.
 *
 * A tap reads, a tap while it reads stops it (`POST /api/speech/stop`, which also cuts what the
 * page already has), and the next tap reads it again from the top. One reply is read at a time:
 * starting another stops this one, and this button goes back to its broadcast icon when its own request
 * comes back stopped.
 *
 * Its states are said in the row it sits in, which is always there, so none of them moves the feed,
 * and in words when nobody is listening or it failed, since a phone has no hover to show a title.
 */

type Reading = { state: "idle" } | { state: "reading" } | { state: "nobody" } | { state: "failed"; reason: string };

type Answer =
  | { state: "played"; durationMs: number }
  | { state: "stopped" }
  | { state: "nobody" }
  | { state: "failed"; reason: string };

/** How long a word about why nothing played stays before the speaker is offered again. */
const NOTICE_MS = 4_000;

async function askToRead(text: string): Promise<Answer> {
  try {
    const response = await fetch(SPEECH_READ_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (response.ok) return { state: "played", durationMs: ((await response.json()) as SpeechReadResponse).durationMs };
    const failure = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (failure?.error?.code === "nobody_listening") return { state: "nobody" };
    if (failure?.error?.code === "stopped") return { state: "stopped" };
    return { state: "failed", reason: failure?.error?.message ?? `the sidecar answered ${response.status}` };
  } catch (error) {
    return { state: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function BroadcastButton({ text }: { text: string }) {
  const [reading, setReading] = useState<Reading>({ state: "idle" });
  // Which request the button shows: one stopped by a tap answers late, and that answer is ignored.
  const shown = useRef(0);
  const idleAfter = (asked: number, ms: number) => {
    setTimeout(
      () => {
        if (shown.current === asked) setReading({ state: "idle" });
      },
      Math.max(0, ms),
    );
  };
  const read = async () => {
    shown.current += 1;
    const asked = shown.current;
    const askedAt = Date.now();
    setReading({ state: "reading" });
    const answer = await askToRead(text);
    if (shown.current !== asked) return;
    if (answer.state === "played") {
      // The answer comes once the whole message is made, while its start is already playing, so what
      // is left of it is its length less the wait.
      idleAfter(asked, answer.durationMs - (Date.now() - askedAt));
    } else if (answer.state === "stopped") {
      setReading({ state: "idle" });
    } else {
      setReading(answer);
      idleAfter(asked, NOTICE_MS);
    }
  };
  const stop = () => {
    shown.current += 1;
    setReading({ state: "idle" });
    void fetch(SPEECH_STOP_ROUTE, { method: "POST" }).catch(() => undefined);
  };
  const isReading = reading.state === "reading";
  const label = isReading ? "Stop broadcast" : "Broadcast to Agent Radio";
  return (
    // Its own items in the row (`ReplyAudioButtons`), with any word after both buttons, so neither moves.
    <div className="contents">
      <button
        type="button"
        onClick={isReading ? stop : () => void read()}
        aria-label={label}
        title={reading.state === "failed" ? reading.reason : label}
        className={replyAudioButtonClass(isReading)}
      >
        {isReading ? (
          <Square aria-hidden className="size-[0.95em] fill-current" />
        ) : (
          <Radio aria-hidden className="size-[1.15em]" />
        )}
      </button>
      {reading.state === "nobody" ? (
        <span className="session-muted-ink order-1">Nobody is listening</span>
      ) : reading.state === "failed" ? (
        <span className="text-destructive order-1">Could not broadcast it</span>
      ) : null}
    </div>
  );
}
