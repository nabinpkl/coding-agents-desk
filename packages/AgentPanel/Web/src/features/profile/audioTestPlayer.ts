// The audio test's player: one `<audio>` element for the whole hour, outside React.
//
// Outside React so it outlives the menu that started it: closing the menu, or the screen locking,
// must not be what stops it. One element for the whole test rather than one per connection,
// because iOS lets an element play once a tap has started it, and the lock screen's play button
// reaches the element already playing; a fresh element on resume would have neither.
//
// The stream is live, so pausing drops the connection, and resuming joins where the stream is
// now (`?from=`), not where it stopped: the count it speaks says how long the gap was.

import { AUDIO_TEST_STREAM_ROUTE } from "@agentdesk/agent-feed-wire";

const LENGTH_MS = 60 * 60_000;

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

export type AudioTestPhase = "idle" | "starting" | "playing" | "paused" | "over";

export type AudioTestState = { phase: AudioTestPhase; status: string | null };

let element: HTMLAudioElement | null = null;
/** Local clock when the test began: stream position is the time since, as on the sidecar. */
let testStartedAt = 0;
/** The stream position the current connection joined at; the element's own clock starts at 0. */
let joinedAtMs = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;
let current: AudioTestState = { phase: "idle", status: null };
const listeners = new Set<() => void>();

function publish(phase: AudioTestPhase, status: string): void {
  current = { phase, status };
  for (const listener of listeners) listener();
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = phase === "playing" || phase === "starting" ? "playing" : "paused";
  }
}

export function subscribeAudioTest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function audioTestState(): AudioTestState {
  return current;
}

/** A playback position as a listener counts it: `12m 35s`. */
export function formatPosition(totalSeconds: number): string {
  const whole = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes === 0 ? `${rest}s` : `${minutes}m ${rest}s`;
}

function heard(audio: HTMLAudioElement): string {
  return formatPosition(joinedAtMs / 1000 + audio.currentTime);
}

/** Drops the connection and keeps the element, so the sidecar stops making lines for nobody. */
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

function connect(audio: HTMLAudioElement, fromMs: number): void {
  joinedAtMs = fromMs;
  // A fresh address each time also keeps anything between here and the sidecar from caching it.
  audio.src = `${AUDIO_TEST_STREAM_ROUTE}?from=${Math.round(fromMs)}`;
  publish("starting", `joining at ${formatPosition(fromMs / 1000)}`);
  startWatchdog(audio);
  audio.play().then(
    () => {
      if (element !== audio || !("mediaSession" in navigator)) return;
      // Only once it plays: iOS ignores Media Session set before the element is what is playing.
      navigator.mediaSession.metadata = new MediaMetadata({ title: "Audio channel test", artist: "AgentDesk" });
      navigator.mediaSession.setActionHandler("pause", pauseAudioTest);
      navigator.mediaSession.setActionHandler("play", resumeAudioTest);
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
    if (mine() && current.phase !== "paused") publish("playing", `playing at ${heard(audio)}`);
  });
  audio.addEventListener("timeupdate", () => {
    const second = Math.round(joinedAtMs / 1000 + audio.currentTime);
    if (!mine() || current.phase !== "playing" || second === shownSecond) return;
    shownSecond = second;
    publish("playing", `playing at ${formatPosition(second)}`);
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
  audio.addEventListener("ended", () => {
    if (!mine()) return;
    stopWatchdog();
    publish("over", `played to the end (${heard(audio)})`);
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
export function startAudioTest(): void {
  stopAudioTest();
  element = createElement();
  testStartedAt = Date.now();
  connect(element, 0);
}

export function pauseAudioTest(): void {
  const audio = element;
  if (!audio || (current.phase !== "playing" && current.phase !== "starting")) return;
  const at = heard(audio);
  // Published first, so the element's own `pause` event reads as ours.
  publish("paused", `paused at ${at}`);
  disconnect(audio);
}

/** Joins the stream where it is now. From a tap or the lock screen's play button. */
export function resumeAudioTest(): void {
  const audio = element;
  if (!audio || current.phase !== "paused") return;
  const fromMs = Date.now() - testStartedAt;
  if (fromMs >= LENGTH_MS) {
    publish("over", "the hour is over");
    return;
  }
  connect(audio, fromMs);
}

export function stopAudioTest(): void {
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
  publish("idle", current.phase === "over" ? (current.status ?? "") : `stopped at ${at}`);
}
