// Dictation from the mic of the device the panel is open on, into one session's composer: the
// browser's own speech recognition, started from the composer's mic menu (`dictationTarget.ts`
// holds the other source, the phone's dictation page). Chrome on a Mac sends the audio to its
// speech service; Chrome on an iPhone is WebKit, which uses Apple's.
//
// One recognizer for the page, so a module store: choosing it on one composer moves it off
// whichever had it. A composer that can take dictation registers where its words go
// (`useDeviceMicSink`); the mic stops when the last one for its session leaves, so it is never left
// listening with nothing on screen to say so. It also stops itself when the panel is hidden, after
// three minutes with no words, and when the browser cuts it off, rather than open session after
// session with the speech service (`RESTART_MS` has the pacing).
//
// Words go in as the phone's do (`public/experiments/local-test.html`): quoted, a phrase recognition
// was unsure of struck through, behind a label that tells the model they were spoken.

import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useSubscription } from "@/hooks/useSubscription";

/** The members used here; TypeScript's DOM types have its events and results but not the recognizer. */
interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  abort(): void;
}

type RecognizerClass = new () => Recognizer;

function recognizerClass(): RecognizerClass | null {
  if (typeof window === "undefined") return null;
  const speech = window as unknown as {
    SpeechRecognition?: RecognizerClass;
    webkitSpeechRecognition?: RecognizerClass;
  };
  return speech.SpeechRecognition ?? speech.webkitSpeechRecognition ?? null;
}

/** Whether this browser can recognise speech at all. */
export function deviceMicSupported(): boolean {
  return recognizerClass() !== null;
}

/**
 * Ahead of the first quoted piece in a composer, so the model knows the words were spoken, may be
 * misheard, and which ones to doubt. The same words the phone's page writes.
 */
export const DICTATION_LABEL =
  "[Dictated by voice: speech recognition may have misheard words, so ask if anything is unclear. Low confidence is marked ~~like this~~]";
/** A phrase recognised with less confidence than this is struck through. */
const UNSURE = 0.5;

/** `value` with one dictated phrase added at its end, labelled if the composer is not already. */
export function withDictation(value: string, phrase: string, confidence: number): string {
  const words = phrase.trim().replace(/"/g, "'");
  if (!words) return value;
  const quoted = `"${confidence < UNSURE ? `~~${words}~~` : words}"`;
  const piece = value.includes(DICTATION_LABEL) ? quoted : `${DICTATION_LABEL} ${quoted}`;
  if (!value) return piece;
  return /\s$/.test(value) ? `${value}${piece}` : `${value} ${piece}`;
}

interface DeviceMicState {
  /** The session this device's mic dictates into, or null while it is off. */
  sessionId: string | null;
  /** Whether the recognizer has started, which comes after the browser has the mic. */
  listening: boolean;
  /** The words still being heard, before recognition finishes the phrase. */
  hearing: string;
  /** Why the mic stopped or did not start, until the next choice, and the session it was for. */
  failure: string | null;
  failedOn: string | null;
}

const OFF: DeviceMicState = { sessionId: null, listening: false, hearing: "", failure: null, failedOn: null };
const mic = createStore<DeviceMicState>(() => OFF);

type Sink = (phrase: string, confidence: number) => void;
/** Where each session's dictation goes; the last composer registered for a session gets it. */
const sinks = new Map<string, Sink[]>();
let recognizer: Recognizer | null = null;

/** Errors that end dictation, said in the reader's terms. The rest (no speech) do not. */
const FATAL: Partial<Record<SpeechRecognitionErrorCode, string>> = {
  "not-allowed": "this browser was not allowed to use the mic",
  "service-not-allowed": "this browser's speech recognition is turned off",
  "audio-capture": "no mic could be opened on this device",
  network: "the speech service could not be reached",
  "language-not-supported": "speech recognition does not support this language",
  // Never ours: a recognizer this module stops is let go first. Chrome holds one mic session for
  // the whole browser and cuts off the last one when another page starts, so listening again would
  // cut that page off in turn, each of them opening a new session with Google every second. WebKit
  // also says this for any failure of Apple's recognizer.
  aborted: "the browser cut it off, most likely another tab or window taking this device's mic",
};

/**
 * Each recognition session in Chrome is a new upload to Google's speech service, so listening
 * again is paced. Chrome ends a session itself after 8 s without speech (`kNoSpeechTimeoutMs` in
 * Chromium's `speech_recognizer_impl.h`), which is the steady case and goes again after
 * `RESTART_MS`. One that ends sooner than `QUICK_END_MS` was refused or cut off rather than
 * finished, so those back off, and enough of them in a minute stop the mic.
 */
const RESTART_MS = 300;
const QUICK_END_MS = 2000;
const QUICK_ENDS_ALLOWED = 5;
const BACKOFF_MAX_MS = 8000;
/** With no word heard for this long, the mic stops: it is not left open to an empty room. */
const IDLE_MS = 3 * 60_000;

/** When recent sessions ended quickly, within the last minute. */
let quickEnds: number[] = [];
let idleTimer: number | undefined;

function stopRecognizer(): void {
  const stopping = recognizer;
  recognizer = null;
  quickEnds = [];
  window.clearTimeout(idleTimer);
  idleTimer = undefined;
  document.removeEventListener("visibilitychange", stopWhenHidden);
  stopping?.abort();
}

function stopBecause(reason: string, sessionId: string): void {
  stopRecognizer();
  mic.setState({ ...OFF, failure: `Dictation stopped: ${reason}`, failedOn: sessionId });
}

/** Desktop Chrome keeps recognising in a background tab, so a hidden panel stops listening itself. */
function stopWhenHidden(): void {
  const { sessionId } = mic.getState();
  if (document.hidden && sessionId !== null) stopBecause("the panel went to the background", sessionId);
}

/**
 * Starts the idle countdown again. A timer, because nothing else says nobody is speaking: Chrome's
 * own end after silence starts the next session rather than stopping, and a noisy room can hold
 * one open with no words in it.
 */
function heardSomething(sessionId: string): void {
  window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => stopBecause("nothing was said for three minutes", sessionId), IDLE_MS);
}

function listen(sessionId: string, Recognition: RecognizerClass): void {
  const recognition = new Recognition();
  recognizer = recognition;
  const startedAt = Date.now();
  recognition.lang = navigator.language || "en-US";
  recognition.continuous = true;
  recognition.interimResults = true;
  // By index within this recognizer: WebKit reports a finished phrase again, and it goes in once.
  const finished: string[] = [];
  recognition.onstart = () => mic.setState({ listening: true });
  recognition.onresult = (event) => {
    heardSomething(sessionId);
    let hearing = "";
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const best = result?.[0];
      if (!result || !best) continue;
      if (!result.isFinal) {
        hearing += best.transcript;
        continue;
      }
      if (finished[i] !== undefined) continue;
      finished[i] = best.transcript;
      const sink = sinks.get(sessionId)?.at(-1);
      sink?.(best.transcript, best.confidence);
    }
    mic.setState({ hearing: hearing.trim() });
  };
  recognition.onerror = (event) => {
    const reason = FATAL[event.error];
    if (reason && recognition === recognizer) stopBecause(reason, sessionId);
  };
  // It ends by itself after a silence; a live mic listens again, paced as `RESTART_MS` says.
  recognition.onend = () => {
    if (recognition !== recognizer) return;
    mic.setState({ listening: false, hearing: "" });
    const now = Date.now();
    quickEnds = quickEnds.filter((at) => now - at < 60_000);
    const quick = now - startedAt < QUICK_END_MS;
    if (quick) quickEnds.push(now);
    if (quickEnds.length >= QUICK_ENDS_ALLOWED) {
      stopBecause("speech recognition kept ending as soon as it started", sessionId);
      return;
    }
    const wait = quick ? Math.min(1000 * 2 ** (quickEnds.length - 1), BACKOFF_MAX_MS) : RESTART_MS;
    window.setTimeout(() => {
      if (recognition !== recognizer) return;
      try {
        listen(sessionId, Recognition);
      } catch (error) {
        stopBecause(`it could not listen again (${error instanceof Error ? error.message : String(error)})`, sessionId);
      }
    }, wait);
  };
  recognition.start();
}

/** Dictates into `sessionId` with this device's mic, moving it off any session that had it. */
export function startDeviceMic(sessionId: string): void {
  const Recognition = recognizerClass();
  if (!Recognition) {
    mic.setState({
      ...OFF,
      failure: "Dictation did not start: this browser has no speech recognition",
      failedOn: sessionId,
    });
    return;
  }
  stopRecognizer();
  mic.setState({ ...OFF, sessionId });
  document.addEventListener("visibilitychange", stopWhenHidden);
  heardSomething(sessionId);
  // Started in the reader's own click, which is what a browser asks before it opens the mic.
  try {
    listen(sessionId, Recognition);
  } catch (error) {
    stopRecognizer();
    const reason = error instanceof Error ? error.message : String(error);
    mic.setState({ ...OFF, failure: `Dictation did not start: ${reason}`, failedOn: sessionId });
  }
}

/** Turns this device's mic off, wherever it was dictating. */
export function stopDeviceMic(): void {
  stopRecognizer();
  mic.setState(OFF);
}

/** The device mic's state as `forSession`'s composer sees it, for `dictationTarget.ts`. */
export function useDeviceMic(forSession: string): Pick<DeviceMicState, "sessionId" | "listening" | "failure"> {
  const sessionId = useStore(mic, (state) => state.sessionId);
  const listening = useStore(mic, (state) => state.listening);
  const failure = useStore(mic, (state) => (state.failedOn === forSession ? state.failure : null));
  return { sessionId, listening, failure };
}

/** What this device's mic is hearing for `sessionId` right now, or "" for nothing. */
export function useDeviceMicHearing(sessionId: string): string {
  return useStore(mic, (state) => (state.sessionId === sessionId ? state.hearing : ""));
}

/**
 * Takes this device's dictation into a composer while `enabled`: each finished phrase is handed to
 * `add` as it arrives. When the last composer for the session dictating leaves, the mic stops.
 */
export function useDeviceMicSink(sessionId: string, enabled: boolean, add: Sink): void {
  const latest = useLatestRef(add);
  useSubscription(enabled ? `device-mic:${sessionId}` : null, () => {
    const sink: Sink = (phrase, confidence) => latest.current(phrase, confidence);
    sinks.set(sessionId, [...(sinks.get(sessionId) ?? []), sink]);
    return () => {
      const left = (sinks.get(sessionId) ?? []).filter((each) => each !== sink);
      if (left.length > 0) sinks.set(sessionId, left);
      else sinks.delete(sessionId);
      if (left.length === 0 && mic.getState().sessionId === sessionId) stopDeviceMic();
    };
  });
}

/** For tests: the mic off and no composer registered. */
export function resetDeviceMic(): void {
  stopDeviceMic();
  sinks.clear();
}
