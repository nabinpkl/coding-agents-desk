"use client";

import { BroadcastButton } from "@/features/audio-channel/BroadcastButton";
import { SpeakHereButton } from "@/features/audio-channel/SpeakHereButton";

/**
 * What ends a reply once it has landed: broadcast it to Agent Radio, or play it on this device. Both
 * are made by this Mac's voice whichever machine the reply came from, so both call this Mac's own
 * `/api`, never the card's machine: a peer has no voice to answer with.
 */
export function ReplyAudioButtons({ text }: { text: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 text-[0.8em]">
      <BroadcastButton text={text} />
      <SpeakHereButton text={text} />
    </div>
  );
}
