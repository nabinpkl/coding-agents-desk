// Which session the phone's dictation streams into, as this Mac's audio process holds it
// (`agent-feed/sidecar/src/audio/speechPushExperiment.ts`). The dictation itself runs on the push
// page (`public/experiments/local-test.html?push=1&mic=1&dictate=1`), which follows this choice and
// can make it too. Always this Mac's `/api/audio`, whichever machine a session is on: the page is
// served from here, and a session id is unique across machines, so the page finds the machine.
//
// The stream also says how many phone pages have their mic on, so the composer's mic can say when
// there is nothing listening to stream.
//
// One choice for the whole page, so a module store: every composer's mic reads it, and choosing one
// session moves it off whichever had it.
//
// The mic's other source is this device's own (`deviceMic.ts`). A composer takes dictation from one
// of the two: choosing either here takes the other off this session.

import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useSubscription } from "@/hooks/useSubscription";
import {
  deviceMicSupported,
  startDeviceMic,
  stopDeviceMic,
  useDeviceMic,
} from "@/features/session-view/composer/deviceMic";

const TARGET_ROUTE = "/api/audio/dictation-target";
const STREAM_ROUTE = `${TARGET_ROUTE}/stream`;

interface TargetState {
  /** The session dictation streams into, or null for none. */
  sessionId: string | null;
  /** How many phone pages have their mic on. */
  mics: number;
  /** Whether the stream has said, since it last connected; until then `sessionId` is a guess. */
  known: boolean;
  /** Why the last choice did not reach the Mac, until the next one. */
  failure: string | null;
}

const target = createStore<TargetState>(() => ({ sessionId: null, mics: 0, known: false, failure: null }));

let readers = 0;
let stream: EventSource | null = null;

/** What an event says, or undefined for one that is not this stream's. */
export function targetIn(data: string): Pick<TargetState, "sessionId" | "mics"> | undefined {
  try {
    const { sessionId, mics } = JSON.parse(data) as { sessionId?: unknown; mics?: unknown };
    if (typeof sessionId !== "string" && sessionId !== null) return undefined;
    if (typeof mics !== "number" || !Number.isInteger(mics) || mics < 0) return undefined;
    return { sessionId, mics };
  } catch {
    return undefined;
  }
}

/** Opens the Mac's stream for the first reader, and closes it after the last. */
function follow(): () => void {
  // Where there is no event stream to follow (a test's DOM), the choice is simply not known.
  if (typeof EventSource === "undefined") return () => {};
  readers += 1;
  if (!stream) {
    const source = new EventSource(STREAM_ROUTE);
    source.onmessage = (event: MessageEvent<string>) => {
      const said = targetIn(event.data);
      if (said) target.setState({ ...said, known: true });
    };
    // It connects again by itself, and says the choice again when it does.
    source.onerror = () => target.setState({ known: false });
    stream = source;
  }
  return () => {
    readers -= 1;
    if (readers > 0) return;
    stream?.close();
    stream = null;
    target.setState({ known: false });
  };
}

/** Streams dictation into `sessionId`, or nowhere for null. Shown at once, put back if refused. */
export async function chooseDictationTarget(sessionId: string | null): Promise<void> {
  const before = target.getState().sessionId;
  target.setState({ sessionId, failure: null });
  try {
    const answer = await fetch(TARGET_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!answer.ok) throw new Error(`the Mac answered ${answer.status}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    target.setState({ sessionId: before, failure: `Dictation target not changed: ${reason}` });
  }
}

export interface DictationTarget {
  /** Dictation streams into this session. */
  here: boolean;
  /** It streams into another one. */
  elsewhere: boolean;
  /** How many phone pages have their mic on: none means nothing streams, wherever it is aimed. */
  mics: number;
  known: boolean;
  failure: string | null;
  /** This device's own mic (`deviceMic.ts`): dictating here, into another session, or neither. */
  device: {
    here: boolean;
    elsewhere: boolean;
    listening: boolean;
    supported: boolean;
    failure: string | null;
  };
  /**
   * `here` streams the phone's dictation into this session, `device` dictates into it with this
   * device's mic, `off` takes both off this one, `stop` stops both wherever they are.
   */
  choose: (choice: DictationChoice) => void;
}

export type DictationChoice = "here" | "device" | "off" | "stop";

/** Where dictation goes, as one session's composer sees it; follows the Mac only while `enabled`. */
export function useDictationTarget(sessionId: string, enabled: boolean): DictationTarget {
  useSubscription(enabled ? STREAM_ROUTE : null, follow);
  const current = useStore(target, (state) => state.sessionId);
  const mics = useStore(target, (state) => state.mics);
  const known = useStore(target, (state) => state.known);
  const failure = useStore(target, (state) => state.failure);
  const device = useDeviceMic(sessionId);
  const deviceHere = device.sessionId === sessionId;
  return {
    here: current === sessionId,
    elsewhere: current !== null && current !== sessionId,
    mics,
    known,
    failure,
    device: {
      here: deviceHere,
      elsewhere: device.sessionId !== null && !deviceHere,
      listening: deviceHere && device.listening,
      supported: deviceMicSupported(),
      failure: device.failure,
    },
    // "Not here" from a session that does not have either changes nothing, rather than clearing
    // another's. The device mic starts inside this call, which is the reader's click.
    choose: (choice) => {
      if (choice === "here") {
        if (deviceHere || device.failure) stopDeviceMic();
        void chooseDictationTarget(sessionId);
      } else if (choice === "device") {
        if (current === sessionId) void chooseDictationTarget(null);
        startDeviceMic(sessionId);
      } else if (choice === "stop") {
        stopDeviceMic();
        void chooseDictationTarget(null);
      } else {
        if (deviceHere || device.failure) stopDeviceMic();
        if (current === sessionId) void chooseDictationTarget(null);
      }
    },
  };
}

/** For tests: forget the choice. */
export function resetDictationTarget(): void {
  target.setState({ sessionId: null, mics: 0, known: false, failure: null });
}
