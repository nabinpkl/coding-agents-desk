/**
 * Ephemeral "momentum" for the voice feature: the run-state machine, the live
 * partial/final transcript, the VU meter, and the preamp gain. None of this is
 * truth. Saved recordings and final analyses live in the TanStack Query cache.
 *
 * On `sessionComplete` the run flips to `complete` and the live transcript is
 * cleared here on purpose: the persisted recording (truth) is fetched from the
 * server, and this store must never shadow it with a stale copy.
 */

import { create } from "zustand";

/**
 * The single discriminated union describing where a voice run is. Loose
 * booleans are forbidden: exactly one of these is true at any instant.
 */
export type VoiceRunState =
  | { readonly status: "idle" }
  | { readonly status: "requestingMic" }
  | { readonly status: "capturing" }
  | { readonly status: "decoding" }
  | { readonly status: "complete"; readonly recordingId: string }
  | { readonly status: "error"; readonly message: string };

export type VoiceRunStatus = VoiceRunState["status"];

/** How the session is being driven. Set once per run, never churned. */
export type VoiceSessionMode = "live" | "replay";

export interface VoiceMeter {
  readonly rms: number;
  readonly peak: number;
}

const SILENT_METER: VoiceMeter = { rms: 0, peak: 0 };

/** Bounds for the preamp slider, shared by the store and the view. */
export const PREAMP_MIN = 1;
export const PREAMP_MAX = 12;
export const PREAMP_DEFAULT = 4;

interface VoiceStoreState {
  readonly runState: VoiceRunState;
  /** Set-once field, independent of the churny run-state union. */
  readonly mode: VoiceSessionMode;
  readonly partialTranscript: string;
  readonly finalTranscript: string;
  readonly meter: VoiceMeter;
  readonly preampGain: number;

  setMode: (mode: VoiceSessionMode) => void;
  setPreampGain: (gain: number) => void;

  requestMic: () => void;
  beginCapture: () => void;
  beginDecode: () => void;

  setPartialTranscript: (text: string) => void;
  setFinalTranscript: (text: string) => void;
  setMeter: (meter: VoiceMeter) => void;

  complete: (recordingId: string) => void;
  fail: (message: string) => void;
  reset: () => void;
}

export const useVoiceStore = create<VoiceStoreState>((set) => ({
  runState: { status: "idle" },
  mode: "live",
  partialTranscript: "",
  finalTranscript: "",
  meter: SILENT_METER,
  preampGain: PREAMP_DEFAULT,

  setMode: (mode) => set({ mode }),
  setPreampGain: (gain) => set({ preampGain: gain }),

  requestMic: () =>
    set({
      runState: { status: "requestingMic" },
      partialTranscript: "",
      finalTranscript: "",
      meter: SILENT_METER,
    }),

  beginCapture: () => set({ runState: { status: "capturing" } }),

  beginDecode: () => set({ runState: { status: "decoding" } }),

  setPartialTranscript: (text) => set({ partialTranscript: text }),
  setFinalTranscript: (text) => set({ finalTranscript: text }),
  setMeter: (meter) => set({ meter }),

  // Truth now lives in the query cache. Drop the live transcript so a view
  // reading this store can never present a stale, unsaved copy.
  complete: (recordingId) =>
    set({
      runState: { status: "complete", recordingId },
      partialTranscript: "",
      finalTranscript: "",
      meter: SILENT_METER,
    }),

  fail: (message) =>
    set({
      runState: { status: "error", message },
      meter: SILENT_METER,
    }),

  reset: () =>
    set({
      runState: { status: "idle" },
      partialTranscript: "",
      finalTranscript: "",
      meter: SILENT_METER,
    }),
}));
