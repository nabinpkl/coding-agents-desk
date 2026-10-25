// How the Mac's speech process treats speech before it is sent (`SPEECH_TUNING_ROUTE`), read and
// changed from the panel. The speech process keeps the settings and their ranges; this page only
// shows them and sends what the reader moves, and a change is heard in the message already playing.

import {
  SPEECH_READ_ROUTE,
  SPEECH_TUNING_ROUTE,
  type SpeechTuning,
  type SpeechTuningState,
} from "@agentdesk/agent-feed-wire";

/** Said by "Hear it": technical words, a number and a failure, which is what the sessions say. */
export const TUNING_SAMPLE =
  "The tmux pane finished its turn, and the ADR is ready for review. Three tests failed in the sidecar, so I stopped before committing anything.";

/** How long a slider's movement is gathered before it is sent: often enough to hear it move. */
export const SEND_GATHER_MS = 120;

async function failure(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return new Error(body?.error?.message ?? `the sidecar answered ${response.status}`);
}

export async function readSpeechTuning(): Promise<SpeechTuningState> {
  const response = await fetch(SPEECH_TUNING_ROUTE);
  if (!response.ok) throw await failure(response);
  return (await response.json()) as SpeechTuningState;
}

export async function sendSpeechTuning(changes: Partial<SpeechTuning>): Promise<SpeechTuningState> {
  const response = await fetch(SPEECH_TUNING_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(changes),
  });
  if (!response.ok) throw await failure(response);
  return (await response.json()) as SpeechTuningState;
}

/** Says the sample on Agent Radio. Null once it is said; otherwise why it was not. */
export async function hearTuning(): Promise<string | null> {
  const response = await fetch(SPEECH_READ_ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: TUNING_SAMPLE }),
  });
  if (response.ok) return null;
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: { code?: string } } | null;
    if (body?.error?.code === "nobody_listening") return "Nobody is listening on Agent Radio.";
    return null; // stopped, or another reading took its place: not a failure
  }
  return (await failure(response)).message;
}

/**
 * Sends what the reader moves, gathered for `SEND_GATHER_MS` and one request at a time, so a slider
 * dragged across its range sends a handful of changes rather than one per pixel. The newest value
 * of each setting is what goes; one moved while a request is out goes in the next.
 */
export function createTuningSender({
  send = sendSpeechTuning,
  onAnswer,
  onFailure,
  gatherMs = SEND_GATHER_MS,
}: {
  send?: (changes: Partial<SpeechTuning>) => Promise<SpeechTuningState>;
  onAnswer: (state: SpeechTuningState) => void;
  onFailure: (error: Error, unsent: Partial<SpeechTuning>) => void;
  gatherMs?: number;
}) {
  let pending: Partial<SpeechTuning> = {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;

  const flush = (): void => {
    timer = null;
    if (sending || Object.keys(pending).length === 0) return;
    const changes = pending;
    pending = {};
    sending = true;
    void send(changes).then(
      (state) => {
        sending = false;
        onAnswer(state);
        if (Object.keys(pending).length > 0) flush();
      },
      (error: unknown) => {
        sending = false;
        // What was refused is handed back, so the reader's values are not quietly taken as sent.
        onFailure(error instanceof Error ? error : new Error(String(error)), { ...changes, ...pending });
        pending = {};
      },
    );
  };

  return {
    change<K extends keyof SpeechTuning>(key: K, value: SpeechTuning[K]): void {
      pending = { ...pending, [key]: value };
      timer ??= setTimeout(flush, gatherMs);
    },
  };
}
