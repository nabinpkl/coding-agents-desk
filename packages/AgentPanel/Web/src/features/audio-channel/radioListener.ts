// Agent Radio heard in the panel itself: the speech process's push stream, the one the push page
// plays (`public/experiments/local-test.html?push=1`), played here so the sessions' announcements
// and a reply broadcast from the feed are heard without a second tab.
//
// It starts from a tap (`startListening`), because iOS lets a page's audio start only inside one;
// after that it plays whatever the Mac pushes, for as long as the page lives. So a reload ends it,
// and nothing but another tap can start it again: the panel remembers that it was listening and
// asks for that tap (`phase: "resume"`) rather than staying quiet without a word.
//
// The stream is read until it drops, then connected again after a growing wait, so a restart of
// the Mac's speech or audio process costs what it pushed while nothing was connected and no more.
// A second stream, the control stream, carries stops at once, where on the audio stream they would
// wait behind the speech already on its way. Speech plays at the speed the Mac paces it for, read
// on each connection and each message, so the push page's slider sets this one too.

import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { createFrameReader, type RadioFrame } from "@/features/audio-channel/radioFrames";
import { toneSamples, VOICE_PROCESSOR, VOICE_WORKLET } from "@/features/audio-channel/voiceWorklet";

export type ListenPhase = "off" | "starting" | "listening" | "reconnecting" | "resume" | "failed";

export type ListenState = {
  phase: ListenPhase;
  detail: string | null;
};

/** The voice's player once it is made: where pieces, speeds and drops are posted. */
export type VoicePort = { postMessage(message: unknown): void };

export type ListenerDeps = {
  makeContext: () => AudioContext;
  makeVoice: (context: AudioContext) => Promise<VoicePort>;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
};

const STORAGE_KEY = "agentdesk.radio.listeningHere";
const LISTEN_URL = "/api/audio/speech-listen";
const EVENTS_URL = "/api/audio/speech-events";
const SPEED_URL = "/api/audio/speech-speed";
/** The waits before each try after a stream dropped, the last repeating; reset once one connects. */
const RECONNECT_MS = [1000, 2000, 4000, 8000, 15000];
/** The Mac sends a keepalive every 5 s, so this long with nothing means the stream has stalled. */
const SILENT_MS = 12_000;

type SessionNavigator = Navigator & { audioSession?: { type: string } };

type Running = {
  context: AudioContext;
  voice: VoicePort | null;
  stop: AbortController;
  speed: number;
  lastMessage: number | null;
  droppedMessage: number | null;
};

async function makeVoiceNode(context: AudioContext): Promise<VoicePort> {
  const url = URL.createObjectURL(new Blob([VOICE_WORKLET], { type: "text/javascript" }));
  await context.audioWorklet.addModule(url);
  const node = new AudioWorkletNode(context, VOICE_PROCESSOR, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });
  node.connect(context.destination);
  return node.port;
}

function browserStorage(): ListenerDeps["storage"] {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export function createRadioListener(deps: ListenerDeps) {
  const remembered = (() => {
    try {
      return deps.storage?.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  })();
  const store = createStore<ListenState>(() => ({
    phase: remembered ? "resume" : "off",
    detail: null,
  }));
  let running: Running | null = null;

  const remember = (listening: boolean) => {
    try {
      if (listening) deps.storage?.setItem(STORAGE_KEY, "1");
      else deps.storage?.removeItem(STORAGE_KEY);
    } catch {
      // a private window still listens; it just will not ask to resume after a reload
    }
  };

  const set = (run: Running, phase: ListenPhase, detail: string | null = null) => {
    if (running === run) store.setState({ phase, detail });
  };

  /** Fetches with the run's stop and a watchdog: a stalled connection raises nothing, so missing keepalives tell. */
  async function readStream(run: Running, url: string, onBytes: (bytes: Uint8Array) => void, onOpen: () => void) {
    const connection = new AbortController();
    const quit = () => connection.abort(new Error("stopped"));
    run.stop.signal.addEventListener("abort", quit);
    let heardAt = Date.now();
    // A timer, justified: a stream that stalls raises nothing; only the missing keepalives tell.
    const watchdog = setInterval(() => {
      if (Date.now() - heardAt > SILENT_MS) connection.abort(new Error("the Mac went quiet"));
    }, 2000);
    try {
      const response = await fetch(`${url}?at=${Date.now()}`, { cache: "no-store", signal: connection.signal });
      if (!response.ok || !response.body) return `the Mac answered ${response.status}`;
      onOpen();
      const reader = response.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return "the stream ended";
        heardAt = Date.now();
        if (value) onBytes(value);
      }
    } catch (error) {
      return connection.signal.aborted ? reasonOf(connection.signal.reason) : reasonOf(error);
    } finally {
      clearInterval(watchdog);
      run.stop.signal.removeEventListener("abort", quit);
    }
  }

  async function loadSpeed(run: Running): Promise<void> {
    try {
      const response = await fetch(SPEED_URL, { cache: "no-store" });
      if (!response.ok) return;
      const { speed } = (await response.json()) as { speed?: unknown };
      if (typeof speed !== "number" || speed === run.speed) return;
      run.speed = speed;
      run.voice?.postMessage({ type: "speed", value: speed });
    } catch {
      // the speed it had stays
    }
  }

  function drop(run: Running, message: number) {
    // Told twice, on the control stream and then on the audio stream behind what was in flight.
    if (run.droppedMessage === message) return;
    run.droppedMessage = message;
    run.voice?.postMessage({ type: "drop", message });
  }

  function play(run: Running, { header, samples }: RadioFrame) {
    if (samples.length === 0) {
      if (typeof header.stop === "number") drop(run, header.stop);
      return;
    }
    const message = header.message;
    if (message === undefined || message === run.droppedMessage) return;
    if (header.index === 0 && message !== run.lastMessage) {
      run.lastMessage = message;
      void loadSpeed(run);
      // A tone is made at the speed it plays at, so it is not stretched.
      if (header.tone) {
        const tone = toneSamples(header.tone);
        run.voice?.postMessage({ type: "piece", samples: tone, made: run.speed, pause: 0, message });
      }
    }
    // A frame of one continuous recording, made at the voice's own pace: queued as it comes.
    run.voice?.postMessage({ type: "piece", samples, made: 1, pause: 0, message });
  }

  async function keepReading(run: Running, url: string, onBytes: () => (bytes: Uint8Array) => void, audio: boolean) {
    for (let tries = 0; !run.stop.signal.aborted;) {
      let opened = false;
      const why = await readStream(run, url, onBytes(), () => {
        opened = true;
        tries = 0;
        if (!audio) return;
        // The speech process numbers messages from 1 again when it restarts, so a number from the
        // last connection could name a new message: a stopped one would silence it.
        run.lastMessage = null;
        run.droppedMessage = null;
        set(run, "listening");
        void loadSpeed(run);
      });
      if (run.stop.signal.aborted) return;
      const wait = RECONNECT_MS[Math.min(tries, RECONNECT_MS.length - 1)] ?? 15_000;
      tries += 1;
      if (audio) set(run, "reconnecting", opened ? why : `${why}; trying again`);
      await waitFor(wait, run.stop.signal);
    }
  }

  async function boot(run: Running) {
    try {
      run.voice = await deps.makeVoice(run.context);
    } catch (error) {
      set(run, "failed", `the player could not start: ${reasonOf(error)}`);
      // Ended, so a tap can start it afresh; the failure stays said until then.
      if (running === run) end();
      return;
    }
    const controlLines = () => {
      const decoder = new TextDecoder();
      let pending = "";
      return (bytes: Uint8Array) => {
        pending += decoder.decode(bytes, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { stop?: unknown };
          if (typeof event.stop === "number") drop(run, event.stop);
        }
      };
    };
    // A fresh reader for each connection, so a frame cut off by a drop is not glued to the next.
    void keepReading(run, EVENTS_URL, controlLines, false);
    void keepReading(run, LISTEN_URL, () => createFrameReader((frame) => play(run, frame)), true);
  }

  /** Ends what is playing, keeping whether it was listening. */
  function end(): void {
    const run = running;
    running = null;
    if (!run) return;
    run.stop.abort();
    void run.context.close().catch(() => undefined);
  }

  return {
    store,
    /** Starts listening. Call it from the tap itself: iOS starts a page's audio only inside one. */
    start(): void {
      if (running) return;
      // iOS plays a page's Web Audio through the ring/silent switch unless it is told this is playback.
      const session = (navigator as SessionNavigator).audioSession;
      if (session && session.type !== "play-and-record") session.type = "playback";
      const context = deps.makeContext();
      void context.resume().catch(() => undefined);
      const run: Running = {
        context,
        voice: null,
        stop: new AbortController(),
        speed: 1,
        lastMessage: null,
        droppedMessage: null,
      };
      running = run;
      remember(true);
      store.setState({ phase: "starting", detail: null });
      void boot(run);
    },
    /** Stops listening, and forgets it was, so a reload does not ask to resume. */
    stop(): void {
      remember(false);
      end();
      store.setState({ phase: "off", detail: null });
    },
    /** Ends what is playing but keeps "was listening", for a module being replaced by a newer copy. */
    end,
  };
}

const listener = createRadioListener({
  makeContext: () => new AudioContext(),
  makeVoice: makeVoiceNode,
  storage: browserStorage(),
});

// An edit to this file replaces the module: the copy playing now stops, and the new one, reading
// that it was listening, asks for the tap that starts it again. Otherwise both would play.
import.meta.hot?.dispose(() => listener.end());

export const startListening = () => listener.start();
export const stopListening = () => listener.stop();

export function useListenState(): ListenState {
  return useStore(listener.store);
}
