"use client";

import { useRef, useState } from "react";
import { Square, Volume2 } from "lucide-react";
import { playHere, type HerePlayback } from "@/features/audio-channel/playHere";
import { replyAudioButtonClass } from "@/features/audio-channel/replyAudioButtonClass";

/**
 * The speaker at the end of an agent's reply: plays it out loud on this device, through whatever
 * it plays sound on, and to nobody else (`playHere`). Beside it, the broadcast button says it to
 * Agent Radio instead (`BroadcastButton`).
 *
 * A tap plays, a tap while it plays stops it, and the next tap plays it again from the top. One
 * reply plays at a time on a page: starting another stops this one, and this button goes back to
 * its speaker.
 */

type Playing = { state: "idle" } | { state: "playing" } | { state: "failed"; reason: string };

/** How long a word about why nothing played stays before the speaker is offered again. */
const NOTICE_MS = 4_000;

export function SpeakHereButton({ text }: { text: string }) {
  const [playing, setPlaying] = useState<Playing>({ state: "idle" });
  // The playback this button shows; one stopped or replaced answers late, and that answer is ignored.
  const shown = useRef<HerePlayback | null>(null);
  const play = () => {
    const playback = playHere(text);
    shown.current = playback;
    setPlaying({ state: "playing" });
    void playback.finished.then((outcome) => {
      if (shown.current !== playback) return;
      shown.current = null;
      if (outcome.state !== "failed") {
        setPlaying({ state: "idle" });
        return;
      }
      setPlaying(outcome);
      setTimeout(() => {
        if (shown.current === null) setPlaying((now) => (now.state === "failed" ? { state: "idle" } : now));
      }, NOTICE_MS);
    });
  };
  const stop = () => {
    const playback = shown.current;
    shown.current = null;
    setPlaying({ state: "idle" });
    playback?.stop();
  };
  const isPlaying = playing.state === "playing";
  const label = isPlaying ? "Stop playing" : "Play on this device";
  return (
    // Its own items in the row (`ReplyAudioButtons`), with any word after both buttons, so neither moves.
    <div className="contents">
      <button
        type="button"
        onClick={isPlaying ? stop : play}
        aria-label={label}
        title={playing.state === "failed" ? playing.reason : label}
        className={replyAudioButtonClass(isPlaying)}
      >
        {isPlaying ? (
          <Square aria-hidden className="size-[0.95em] fill-current" />
        ) : (
          <Volume2 aria-hidden className="size-[1.15em]" />
        )}
      </button>
      {playing.state === "failed" ? <span className="text-destructive order-1">Could not play it</span> : null}
    </div>
  );
}
