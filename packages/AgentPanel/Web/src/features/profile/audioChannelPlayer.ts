// The audio channel's player: one `<audio>` element on the sidecar's stream, outside React.
//
// The stream is silence until an agent speaks into it (`POST /api/audio/speak` on the sidecar).
// Outside React so it outlives the menu that started it: closing the menu, or the screen locking,
// must not be what stops it. One element for the whole time rather than one per connection,
// because iOS lets an element play once a tap has started it, and the lock screen's play button
// reaches the element already playing; a fresh element on resume would have neither.
//
// The stream is live, so pausing drops the connection, and resuming connects again: whatever was
// said while paused was said to nobody here, and the sidecar did not count this phone as listening.

import { AUDIO_STREAM_ROUTE } from "@agentdesk/agent-feed-wire";

/**
 * How long playback may sit still, with audio in hand and not paused, before it counts as taken.
 * Measured on an iPhone: when another app took the audio, the element stopped without a `pause`
 * event and the menu went on saying "playing" at the same second.
 */
const STILL_MS = 3_000;

/**
 * The same for an element still waiting on the network. Longer, because a slow network is not
 * an interruption, but a live stream that has sent nothing for this long has stopped.
 */
const STALLED_MS = 10_000;

/** HTMLMediaElement.HAVE_FUTURE_DATA: below it a still element is waiting for the network. */
const HAVE_FUTURE_DATA = 3;

const MEDIA_ERRORS: Record<number, string> = {
  1: "aborted",
  2: "network error",
  3: "could not decode",
  4: "format refused",
};

export type AudioChannelPhase = "idle" | "starting" | "playing" | "paused";

export type AudioChannelState = { phase: AudioChannelPhase; status: string | null };

let element: HTMLAudioElement | null = null;
/** Local clock when listening began, for saying how long it has been. */
let listeningSince = 0;
/** How long after that the current connection was made; the element's own clock starts at 0. */
let joinedAfterMs = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;
let current: AudioChannelState = { phase: "idle", status: null };
const listeners = new Set<() => void>();

function publish(phase: AudioChannelPhase, status: string): void {
  current = { phase, status };
  for (const listener of listeners) listener();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = phase === "playing" || phase === "starting" ? "playing" : "paused";
  }
}

export function subscribeAudioChannel(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function audioChannelState(): AudioChannelState {
  return current;
}

/** A length of time as a listener counts it: `12m 35s`. */
export function formatDuration(totalSeconds: number): string {
  const whole = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes === 0 ? `${rest}s` : `${minutes}m ${rest}s`;
}

/** How far into listening the element has played. */
function heard(audio: HTMLAudioElement): string {
  return formatDuration(joinedAfterMs / 1000 + audio.currentTime);
}

/** Drops the connection and keeps the element, so the sidecar stops counting this as a listener. */
function disconnect(audio: HTMLAudioElement): void {
  stopWatchdog();
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

function stopWatchdog(): void {
  if (watchdog !== null) clearInterval(watchdog);
  watchdog = null;
}

/**
 * Notices playback that stopped without saying so. A poll, because nothing announces it: iOS
 * raised no event when another app took the audio. Checked every second while connected; a page
 * the system suspended checks late, and its first check after waking sees the stale position.
 */
function startWatchdog(audio: HTMLAudioElement): void {
  stopWatchdog();
  let lastTime = audio.currentTime;
  let movedAt = Date.now();
  watchdog = setInterval(() => {
    if (audio.currentTime !== lastTime) {
      lastTime = audio.currentTime;
      movedAt = Date.now();
      return;
    }
    // `paused` is not consulted: an element the system paused without saying so is the case here.
    if (current.phase !== "playing" && current.phase !== "starting") return;
    const stillFor = Date.now() - movedAt;
    // A connection that has not started playing yet gets the longer allowance too.
    const waiting = current.phase === "starting" || audio.readyState < HAVE_FUTURE_DATA;
    if (stillFor < (waiting ? STALLED_MS : STILL_MS)) return;
    const at = heard(audio);
    disconnect(audio);
    publish("paused", waiting ? `stream stalled at ${at}` : `interrupted at ${at}, likely another app's audio`);
  }, 1_000);
}

function connect(audio: HTMLAudioElement): void {
  joinedAfterMs = Date.now() - listeningSince;
  // A fresh address each time also keeps anything between here and the sidecar from caching it.
  audio.src = `${AUDIO_STREAM_ROUTE}?at=${Date.now()}`;
  publish("starting", "connecting");
  startWatchdog(audio);
  audio.play().then(
    () => {
      if (element !== audio || !("mediaSession" in navigator)) return;
      // Only once it plays: iOS ignores Media Session set before the element is what is playing.
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Agent messages", artist: "AgentDesk" });
      navigator.mediaSession.setActionHandler("pause", pauseListening);
      navigator.mediaSession.setActionHandler("play", resumeListening);
    },
    (error: unknown) => {
      if (element !== audio || current.phase !== "starting") return;
      disconnect(audio);
      publish("paused", `could not start: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
}

function createElement(): HTMLAudioElement {
  const audio = new Audio();
  const mine = () => element === audio;
  let shownSecond = -1;
  audio.addEventListener("playing", () => {
    if (mine() && current.phase !== "paused") publish("playing", `listening, ${heard(audio)}`);
  });
  audio.addEventListener("timeupdate", () => {
    const second = Math.round(joinedAfterMs / 1000 + audio.currentTime);
    if (!mine() || current.phase !== "playing" || second === shownSecond) return;
    shownSecond = second;
    publish("playing", `listening, ${formatDuration(second)}`);
  });
  audio.addEventListener("waiting", () => {
    if (mine() && current.phase === "playing") publish("playing", `waiting for audio at ${heard(audio)}`);
  });
  // A pause this module did not ask for: the system's, or the lock screen's before its handler ran.
  audio.addEventListener("pause", () => {
    if (!mine() || audio.ended || (current.phase !== "playing" && current.phase !== "starting")) return;
    const at = heard(audio);
    disconnect(audio);
    publish("paused", `paused at ${at}`);
  });
  // The sidecar ends a stream only by going away, a restart among them; connecting again is resuming.
  audio.addEventListener("ended", () => {
    if (!mine()) return;
    const at = heard(audio);
    disconnect(audio);
    publish("paused", `the stream ended at ${at}`);
  });
  audio.addEventListener("error", () => {
    // An error after a disconnect is the dropped source, not a failure.
    if (!mine() || (current.phase !== "playing" && current.phase !== "starting")) return;
    const error = audio.error;
    const reason = error ? (MEDIA_ERRORS[error.code] ?? `error ${error.code}`) : "unknown error";
    const at = heard(audio);
    disconnect(audio);
    publish("paused", `stopped at ${at}: ${reason}${error?.message ? `, ${error.message}` : ""}`);
  });
  return audio;
}

/** Must run inside the tap's own handler: a phone starts audio only from a gesture. */
export function startListening(): void {
  stopListening();
  element = createElement();
  listeningSince = Date.now();
  connect(element);
}

export function pauseListening(): void {
  const audio = element;
  if (!audio || (current.phase !== "playing" && current.phase !== "starting")) return;
  const at = heard(audio);
  // Published first, so the element's own `pause` event reads as ours.
  publish("paused", `paused at ${at}`);
  disconnect(audio);
}

/** Connects again. From a tap or the lock screen's play button. */
export function resumeListening(): void {
  const audio = element;
  if (!audio || current.phase !== "paused") return;
  connect(audio);
}

export function stopListening(): void {
  const audio = element;
  if (!audio) return;
  const at = heard(audio);
  element = null;
  disconnect(audio);
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("pause", null);
    navigator.mediaSession.setActionHandler("play", null);
    navigator.mediaSession.metadata = null;
  }
  publish("idle", `stopped after ${at}`);
}
