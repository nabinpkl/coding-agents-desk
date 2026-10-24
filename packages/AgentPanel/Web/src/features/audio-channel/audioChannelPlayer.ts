// The audio channel's player, for Agent Radio (`listenPage.ts`): one `<audio>` element on the audio
// process's stream, held by this module and handed state through `subscribeAudioChannel`.
//
// The stream is a bed of noise, in the color and at the level this device picks, with agents'
// messages over it at the voice level it picks (`POST /api/audio/speak`). Both are mixed by the
// audio process on the Mac,
// not here: iOS ignores a page setting an element's volume, and a page's own Web Audio is suspended
// once the screen locks, which is exactly when this has to keep playing.
//
// One element for the whole time rather than one per connection, because iOS lets an element play
// once a tap has started it, and the lock screen's play button reaches the element already
// playing; a fresh element on resume would have neither.
//
// The stream is live, so pausing drops the connection, and resuming connects again: whatever was
// said while paused was said to nobody here, and the audio process did not count this phone as
// listening. A stream that drops on its own is reconnected after a short wait, on the same element.

import {
  AUDIO_LEVEL_MAX,
  AUDIO_MIX_ROUTE,
  AUDIO_NOISE_COLORS,
  AUDIO_STREAM_ROUTE,
  type AudioNoiseColor,
  type AudioMixRequest,
} from "@agentdesk/agent-feed-wire";

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

export type AudioChannelState = {
  phase: AudioChannelPhase;
  status: string | null;
  noise: number;
  color: AudioNoiseColor;
  voice: number;
};

/** Where this device's mix is remembered. A convenience: a missing value means the default. */
const NOISE_STORAGE_KEY = "agentdesk.audioChannel.noiseLevel";
const COLOR_STORAGE_KEY = "agentdesk.audioChannel.noiseColor";
const VOICE_STORAGE_KEY = "agentdesk.audioChannel.voiceLevel";
const DEFAULT_NOISE = 3;
const DEFAULT_COLOR: AudioNoiseColor = "pink";
/** About as `say` speaks; 10 is the loudest that does not clip. */
const DEFAULT_VOICE = 8;

function storedColor(): AudioNoiseColor {
  try {
    const stored = localStorage.getItem(COLOR_STORAGE_KEY);
    return AUDIO_NOISE_COLORS.find((color) => color === stored) ?? DEFAULT_COLOR;
  } catch {
    return DEFAULT_COLOR;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered, which only costs the default next time.
  }
}

function storedLevel(key: string, fallback: number): number {
  try {
    const stored = localStorage.getItem(key);
    const level = Number(stored);
    return stored !== null && Number.isFinite(level) ? clampLevel(level) : fallback;
  } catch {
    return fallback;
  }
}

function clampLevel(level: number): number {
  return Math.min(AUDIO_LEVEL_MAX, Math.max(0, Math.round(level)));
}

/**
 * This device's name to the audio process, made once per page: it keeps the mix under
 * it, and counts a phone's probe connection and its playing one as one listener.
 */
const LISTENER_ID = crypto.randomUUID();

let element: HTMLAudioElement | null = null;
/** Local clock when listening began, for saying how long it has been. */
let listeningSince = 0;
/** How long after that the current connection was made; the element's own clock starts at 0. */
let joinedAfterMs = 0;
let watchdog: ReturnType<typeof setInterval> | null = null;

/**
 * The waits before each try to reconnect after a stream dropped, the last repeating; reset once one
 * plays. A stream drops when the audio process is replaced (an edit to its own code) or the dev
 * server restarts, and either is back within seconds.
 */
const RECONNECT_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnects = 0;
let current: AudioChannelState = {
  phase: "idle",
  status: null,
  noise: storedLevel(NOISE_STORAGE_KEY, DEFAULT_NOISE),
  color: storedColor(),
  voice: storedLevel(VOICE_STORAGE_KEY, DEFAULT_VOICE),
};
const listeners = new Set<() => void>();

function publish(phase: AudioChannelPhase, status: string): void {
  current = { ...current, phase, status };
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

/** Drops the connection and keeps the element, so the audio process stops counting this as a listener. */
function disconnect(audio: HTMLAudioElement): void {
  stopWatchdog();
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

function cancelReconnect(): void {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

/**
 * The stream dropped under a listener who did not ask it to: connect again after a short wait, on
 * the same element, which iOS lets play without a new tap because a tap already started it. Not for
 * another app taking the audio: that is the listener's phone deciding, and they resume it.
 */
function reconnectSoon(audio: HTMLAudioElement, why: string): void {
  disconnect(audio);
  cancelReconnect();
  const wait = RECONNECT_MS[Math.min(reconnects, RECONNECT_MS.length - 1)] ?? 15_000;
  reconnects += 1;
  publish("starting", `${why}; reconnecting in ${Math.round(wait / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (element === audio && current.phase === "starting") connect(audio, `reconnecting, try ${reconnects}`);
  }, wait);
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
    if (waiting) {
      reconnectSoon(audio, `the stream stalled at ${at}`);
      return;
    }
    disconnect(audio);
    publish("paused", `interrupted at ${at}, likely another app's audio`);
  }, 1_000);
}

function connect(audio: HTMLAudioElement, saying = "connecting"): void {
  joinedAfterMs = Date.now() - listeningSince;
  // A fresh address each time (`at`) also keeps anything between here and the Mac from caching it.
  const mix = `noise=${current.noise}&color=${current.color}&voice=${current.voice}`;
  audio.src = `${AUDIO_STREAM_ROUTE}?listener=${LISTENER_ID}&${mix}&at=${Date.now()}`;
  publish("starting", saying);
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
      // A reconnect the browser refused to play without a tap ends here: Resume is that tap.
      publish("paused", `could not start: ${error instanceof Error ? error.message : String(error)}`);
    },
  );
}

function createElement(): HTMLAudioElement {
  const audio = new Audio();
  const mine = () => element === audio;
  let shownSecond = -1;
  audio.addEventListener("playing", () => {
    if (!mine() || current.phase === "paused") return;
    reconnects = 0;
    publish("playing", `listening, ${heard(audio)}`);
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
  // The audio process ends a stream only by going away, a restart among them.
  audio.addEventListener("ended", () => {
    if (mine() && (current.phase === "playing" || current.phase === "starting")) {
      reconnectSoon(audio, `the stream ended at ${heard(audio)}`);
    }
  });
  audio.addEventListener("error", () => {
    // An error after a disconnect is the dropped source, not a failure.
    if (!mine() || (current.phase !== "playing" && current.phase !== "starting")) return;
    const error = audio.error;
    const reason = error ? (MEDIA_ERRORS[error.code] ?? `error ${error.code}`) : "unknown error";
    reconnectSoon(audio, `dropped at ${heard(audio)}: ${reason}${error?.message ? `, ${error.message}` : ""}`);
  });
  return audio;
}

/** Must run inside the tap's own handler: a phone starts audio only from a gesture. */
export function startListening(): void {
  stopListening();
  element = createElement();
  listeningSince = Date.now();
  reconnects = 0;
  connect(element);
}

export function pauseListening(): void {
  const audio = element;
  if (!audio || (current.phase !== "playing" && current.phase !== "starting")) return;
  const at = heard(audio);
  cancelReconnect();
  // Published first, so the element's own `pause` event reads as ours.
  publish("paused", `paused at ${at}`);
  disconnect(audio);
}

/** Connects again. From a tap or the lock screen's play button. */
export function resumeListening(): void {
  const audio = element;
  if (!audio || current.phase !== "paused") return;
  reconnects = 0;
  connect(audio);
}

export function stopListening(): void {
  const audio = element;
  if (!audio) return;
  const at = heard(audio);
  element = null;
  cancelReconnect();
  disconnect(audio);
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("pause", null);
    navigator.mediaSession.setActionHandler("play", null);
    navigator.mediaSession.metadata = null;
  }
  publish("idle", `stopped after ${at}`);
}

/**
 * Tells the audio process about a mix change while connected; it switches at once, and the change
 * is heard once what the stream sent ahead has played, about six seconds. Not connected, the next
 * connection carries it.
 */
function sendMix(change: Omit<AudioMixRequest, "listener">): void {
  for (const listener of listeners) listener();
  if (current.phase !== "playing" && current.phase !== "starting") return;
  const request: AudioMixRequest = { listener: LISTENER_ID, ...change };
  void fetch(AUDIO_MIX_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  }).then(
    (response) => {
      if (!response.ok) console.warn(`[audio] mix change ${JSON.stringify(change)} refused: ${response.status}`);
    },
    (error: unknown) => console.warn("[audio] mix change not sent", error),
  );
}

/** Sets this device's noise level, remembered for next time. */
export function setNoiseLevel(level: number): void {
  const noise = clampLevel(level);
  current = { ...current, noise };
  remember(NOISE_STORAGE_KEY, String(noise));
  sendMix({ noise });
}

/** Sets this device's voice level, how loud messages are over the noise, remembered for next time. */
export function setVoiceLevel(level: number): void {
  const voice = clampLevel(level);
  current = { ...current, voice };
  remember(VOICE_STORAGE_KEY, String(voice));
  sendMix({ voice });
}

/** Sets this device's noise color, remembered for next time. */
export function setNoiseColor(color: AudioNoiseColor): void {
  current = { ...current, color };
  remember(COLOR_STORAGE_KEY, color);
  sendMix({ color });
}
