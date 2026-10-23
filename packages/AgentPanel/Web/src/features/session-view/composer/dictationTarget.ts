// Which session the phone's dictation streams into, as this Mac's audio process holds it
// (`agent-feed/sidecar/src/audio/speechPushExperiment.ts`). The dictation itself runs on the push
// page (`public/experiments/local-test.html?push=1&mic=1&dictate=1`), which follows this choice and
// can make it too. Always this Mac's `/api/audio`, whichever machine a session is on: the page is
// served from here, and a session id is unique across machines, so the page finds the machine.
//
// One choice for the whole page, so a module store: every composer's mic reads it, and choosing one
// session moves it off whichever had it.

import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { useSubscription } from "@/hooks/useSubscription";

const TARGET_ROUTE = "/api/audio/dictation-target";
const STREAM_ROUTE = `${TARGET_ROUTE}/stream`;

interface TargetState {
  /** The session dictation streams into, or null for none. */
  sessionId: string | null;
  /** Whether the stream has said, since it last connected; until then `sessionId` is a guess. */
  known: boolean;
  /** Why the last choice did not reach the Mac, until the next one. */
  failure: string | null;
}

const target = createStore<TargetState>(() => ({ sessionId: null, known: false, failure: null }));

let readers = 0;
let stream: EventSource | null = null;

/** The `sessionId` an event carries, or undefined for one that is not this stream's. */
export function targetIn(data: string): string | null | undefined {
  try {
    const sessionId: unknown = (JSON.parse(data) as { sessionId?: unknown })?.sessionId;
    return typeof sessionId === "string" || sessionId === null ? sessionId : undefined;
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
      const sessionId = targetIn(event.data);
      if (sessionId !== undefined) target.setState({ sessionId, known: true });
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
  known: boolean;
  failure: string | null;
  /** `here` streams into this session, `off` takes it off this one, `stop` stops it wherever it is. */
  choose: (choice: DictationChoice) => void;
}

export type DictationChoice = "here" | "off" | "stop";

/** Where dictation goes, as one session's composer sees it; follows the Mac only while `enabled`. */
export function useDictationTarget(sessionId: string, enabled: boolean): DictationTarget {
  useSubscription(enabled ? STREAM_ROUTE : null, follow);
  const current = useStore(target, (state) => state.sessionId);
  const known = useStore(target, (state) => state.known);
  const failure = useStore(target, (state) => state.failure);
  return {
    here: current === sessionId,
    elsewhere: current !== null && current !== sessionId,
    known,
    failure,
    // "Not here" from a session that does not have it changes nothing, rather than clearing another's.
    choose: (choice) => {
      if (choice === "here") void chooseDictationTarget(sessionId);
      else if (choice === "stop" || current === sessionId) void chooseDictationTarget(null);
    },
  };
}

/** For tests: forget the choice. */
export function resetDictationTarget(): void {
  target.setState({ sessionId: null, known: false, failure: null });
}
