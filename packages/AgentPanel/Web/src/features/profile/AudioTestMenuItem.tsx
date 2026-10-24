// A test of the spoken audio channel: play the sidecar's hour-long stream, then lock the phone.
//
// The question it answers is whether an iPhone keeps playing a live stream from the panel installed
// to its Home Screen once the screen locks, which the evidence leaves open. So the player lives
// outside React, in this module, and outlives the menu that started it: closing the menu, or the
// screen locking, must not be what stops it. The menu reads where it got to when it is opened again.

import { useSyncExternalStore } from "react";
import { Square, Volume2 } from "lucide-react";
import { AUDIO_TEST_STREAM_ROUTE } from "@agentdesk/agent-feed-wire";
import { PROFILE_MENU_ITEM_CLASS } from "@/features/profile/PushMenuItems";

type AudioTest = { active: boolean; status: string | null };

const MEDIA_ERRORS: Record<number, string> = {
  1: "aborted",
  2: "network error",
  3: "could not decode",
  4: "format refused",
};

let player: HTMLAudioElement | null = null;
let current: AudioTest = { active: false, status: null };
const listeners = new Set<() => void>();

function publish(next: AudioTest): void {
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A playback position as a listener counts it: `12m 35s`. */
function position(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds % 60;
  return minutes === 0 ? `${rest}s` : `${minutes}m ${rest}s`;
}

function at(element: HTMLAudioElement): string {
  return position(Math.round(element.currentTime));
}

function stopAudioTest(): void {
  const element = player;
  if (!element) return;
  player = null;
  const stoppedAt = at(element);
  element.pause();
  // Dropping the source is what closes the connection; a paused element keeps it open.
  element.removeAttribute("src");
  element.load();
  publish({ active: false, status: `stopped at ${stoppedAt}` });
}

/** Must run inside the tap's own handler: a phone starts audio only from a gesture. */
function startAudioTest(): void {
  stopAudioTest();
  const element = new Audio();
  player = element;
  const mine = () => player === element;
  let shownSecond = -1;
  element.addEventListener("playing", () => {
    if (mine()) publish({ active: true, status: `playing at ${at(element)}` });
  });
  element.addEventListener("timeupdate", () => {
    const second = Math.round(element.currentTime);
    if (!mine() || second === shownSecond) return;
    shownSecond = second;
    publish({ active: true, status: `playing at ${position(second)}` });
  });
  element.addEventListener("waiting", () => {
    if (mine()) publish({ active: true, status: `waiting for audio at ${at(element)}` });
  });
  element.addEventListener("pause", () => {
    if (mine() && !element.ended) publish({ active: true, status: `paused at ${at(element)}` });
  });
  element.addEventListener("ended", () => {
    if (!mine()) return;
    player = null;
    publish({ active: false, status: `played to the end (${at(element)})` });
  });
  element.addEventListener("error", () => {
    if (!mine()) return;
    player = null;
    const error = element.error;
    const reason = error ? (MEDIA_ERRORS[error.code] ?? `error ${error.code}`) : "unknown error";
    publish({
      active: false,
      status: `stopped at ${at(element)}: ${reason}${error?.message ? `, ${error.message}` : ""}`,
    });
  });
  // A fresh address per press, so nothing between here and the sidecar can answer from a cache.
  element.src = `${AUDIO_TEST_STREAM_ROUTE}?at=${Date.now()}`;
  publish({ active: true, status: "starting" });
  element.play().then(
    () => {
      if (!mine() || !("mediaSession" in navigator)) return;
      // Only once it plays: iOS ignores Media Session set before the element is what is playing.
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Audio channel test", artist: "AgentDesk" });
      navigator.mediaSession.setActionHandler("pause", () => element.pause());
      navigator.mediaSession.setActionHandler("play", () => void element.play());
    },
    (error: unknown) => {
      if (!mine()) return;
      player = null;
      publish({ active: false, status: `could not start: ${error instanceof Error ? error.message : String(error)}` });
    },
  );
}

/** The Profile menu's entry that starts and stops the audio test, saying where it got to. */
export function AudioTestMenuItem() {
  const test = useSyncExternalStore(subscribe, () => current);
  return (
    <>
      <button
        type="button"
        role="menuitem"
        onClick={test.active ? stopAudioTest : startAudioTest}
        className={PROFILE_MENU_ITEM_CLASS}
      >
        {test.active ? (
          <Square className="size-4 shrink-0" aria-hidden />
        ) : (
          <Volume2 className="size-4 shrink-0" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">{test.active ? "Stop audio test" : "Test audio stream"}</span>
        <span className="shrink-0 text-xs text-muted-foreground">1 hr</span>
      </button>
      {test.status ? (
        <p role="status" className="border-t border-border px-3 py-1.5 text-xs break-words text-muted-foreground">
          {test.status}
        </p>
      ) : null}
    </>
  );
}
