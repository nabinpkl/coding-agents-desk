"use client";

import { useEffect, useState } from "react";

import {
  INTERACTION_HANDLER,
  isEmbedded,
  postToHost,
} from "@/lib/host-bridge";
import { subscribeInteractionDelivery } from "@/lib/interaction-delivery";

export type ReferenceSpeechVoiceQuality = "basic" | "enhanced" | "premium";
export const REFERENCE_SPEECH_LANGUAGE = "en-US";

export interface ReferenceSpeechVoice {
  identifier: string;
  name: string;
  language: string;
  quality: ReferenceSpeechVoiceQuality;
}

export interface ReferenceSpeechRateState {
  minimum: number;
  defaultValue: number;
  maximum: number;
  current: number;
}

export interface ReferenceSpeechState {
  language: string;
  voices: ReferenceSpeechVoice[];
  selectedVoiceIdentifier?: string | null;
  rate: ReferenceSpeechRateState;
  notice?: string | null;
  error?: string | null;
}

export type ReferenceSpeechSettingsView =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; state: ReferenceSpeechState; updating: boolean };

const BROWSER_VOICE_KEY = "agentDesk.referenceSpeech.voiceIdentifier";
const BROWSER_RATE_KEY = "agentDesk.referenceSpeech.rate";
const BROWSER_MINIMUM_RATE = 0;
const BROWSER_DEFAULT_RATE = 0.5;
const BROWSER_MAXIMUM_RATE = 1;

function isFiniteRateState(value: unknown): value is ReferenceSpeechRateState {
  const rate = value as Partial<ReferenceSpeechRateState>;
  return (
    Number.isFinite(rate?.minimum) &&
    Number.isFinite(rate?.defaultValue) &&
    Number.isFinite(rate?.maximum) &&
    Number.isFinite(rate?.current) &&
    (rate.minimum as number) <= (rate.maximum as number) &&
    (rate.current as number) >= (rate.minimum as number) &&
    (rate.current as number) <= (rate.maximum as number)
  );
}

export function parseReferenceSpeechState(
  payload: unknown,
): ReferenceSpeechState | null {
  const value = payload as Partial<ReferenceSpeechState>;
  if (
    value?.language !== REFERENCE_SPEECH_LANGUAGE ||
    !Array.isArray(value.voices) ||
    !isFiniteRateState(value.rate)
  ) {
    return null;
  }
  const voices: ReferenceSpeechVoice[] = [];
  for (const voice of value.voices) {
    if (
      typeof voice?.identifier !== "string" ||
      voice.identifier.length === 0 ||
      typeof voice.name !== "string" ||
      typeof voice.language !== "string" ||
      !["basic", "enhanced", "premium"].includes(voice.quality)
    ) {
      return null;
    }
    voices.push(voice);
  }
  if (
    value.selectedVoiceIdentifier !== undefined &&
    value.selectedVoiceIdentifier !== null &&
    typeof value.selectedVoiceIdentifier !== "string"
  ) {
    return null;
  }
  return {
    language: value.language,
    voices,
    selectedVoiceIdentifier: value.selectedVoiceIdentifier ?? null,
    rate: value.rate,
    notice: typeof value.notice === "string" ? value.notice : null,
    error: typeof value.error === "string" ? value.error : null,
  };
}

function browserStoredRate(): number {
  if (typeof window === "undefined") return BROWSER_DEFAULT_RATE;
  const storedValue = window.localStorage.getItem(BROWSER_RATE_KEY);
  if (storedValue === null) return BROWSER_DEFAULT_RATE;
  const value = Number(storedValue);
  if (!Number.isFinite(value)) return BROWSER_DEFAULT_RATE;
  return Math.min(BROWSER_MAXIMUM_RATE, Math.max(BROWSER_MINIMUM_RATE, value));
}

function browserState(): ReferenceSpeechState {
  const synthesizer = window.speechSynthesis;
  const voices = synthesizer
    .getVoices()
    .filter((voice) => voice.lang === REFERENCE_SPEECH_LANGUAGE)
    .map((voice) => ({
      identifier: voice.voiceURI,
      name: voice.name,
      language: voice.lang,
      quality: "basic" as const,
    }))
    .sort((lhs, rhs) => lhs.name.localeCompare(rhs.name));
  const storedIdentifier = window.localStorage.getItem(BROWSER_VOICE_KEY);
  const selectedVoiceIdentifier = voices.some(
    (voice) => voice.identifier === storedIdentifier,
  )
    ? storedIdentifier
    : null;
  if (storedIdentifier && selectedVoiceIdentifier === null) {
    window.localStorage.removeItem(BROWSER_VOICE_KEY);
  }
  return {
    language: REFERENCE_SPEECH_LANGUAGE,
    voices,
    selectedVoiceIdentifier,
    rate: {
      minimum: BROWSER_MINIMUM_RATE,
      defaultValue: BROWSER_DEFAULT_RATE,
      maximum: BROWSER_MAXIMUM_RATE,
      current: browserStoredRate(),
    },
    notice:
      storedIdentifier && selectedVoiceIdentifier === null
        ? "The previously selected voice is no longer available. Using System Default."
        : null,
    error: null,
  };
}

export function requestReferenceSpeechState(): void {
  postToHost(INTERACTION_HANDLER, { t: "referenceSpeechStateRequest" });
}

export function postReferenceSpeechPreferencesUpdate(
  voiceIdentifier: string | null,
  rate: number,
): void {
  if (
    (voiceIdentifier !== null && voiceIdentifier.length === 0) ||
    !Number.isFinite(rate)
  ) {
    throw new Error("Reference speech preferences are invalid.");
  }
  postToHost(INTERACTION_HANDLER, {
    t: "referenceSpeechPreferencesUpdate",
    voiceIdentifier,
    rate,
  });
}

export function useReferenceSpeechSettings(): {
  view: ReferenceSpeechSettingsView;
  update: (voiceIdentifier: string | null, rate: number) => void;
  refresh: () => void;
} {
  const embedded = isEmbedded();
  const [view, setView] = useState<ReferenceSpeechSettingsView>({
    status: "loading",
  });

  useEffect(() => {
    if (embedded) {
      const unsubscribe = subscribeInteractionDelivery(
        "referenceSpeechState",
        (payload) => {
          const state = parseReferenceSpeechState(payload);
          setView(
            state
              ? { status: "ready", state, updating: false }
              : {
                  status: "error",
                  message: "Native reference speech returned invalid settings.",
                },
          );
        },
      );
      const refreshWhenVisible = () => {
        if (document.visibilityState === "visible") {
          requestReferenceSpeechState();
        }
      };
      document.addEventListener("visibilitychange", refreshWhenVisible);
      requestReferenceSpeechState();
      return () => {
        document.removeEventListener("visibilitychange", refreshWhenVisible);
        unsubscribe();
      };
    }

    let cancelled = false;
    if (
      typeof window === "undefined" ||
      typeof window.speechSynthesis === "undefined"
    ) {
      queueMicrotask(() => {
        if (cancelled) return;
        setView({
          status: "error",
          message: "Reference speech is unavailable in this browser.",
        });
      });
      return () => {
        cancelled = true;
      };
    }
    const refreshBrowser = () => {
      if (cancelled) return;
      setView({ status: "ready", state: browserState(), updating: false });
    };
    window.speechSynthesis.addEventListener("voiceschanged", refreshBrowser);
    queueMicrotask(refreshBrowser);
    return () => {
      cancelled = true;
      window.speechSynthesis.removeEventListener(
        "voiceschanged",
        refreshBrowser,
      );
    };
  }, [embedded]);

  function refresh(): void {
    if (embedded) {
      requestReferenceSpeechState();
    } else if (
      typeof window !== "undefined" &&
      typeof window.speechSynthesis !== "undefined"
    ) {
      setView({ status: "ready", state: browserState(), updating: false });
    }
  }

  function update(voiceIdentifier: string | null, rate: number): void {
    if (embedded) {
      setView((current) =>
        current.status === "ready"
          ? { ...current, updating: true }
          : current,
      );
      postReferenceSpeechPreferencesUpdate(voiceIdentifier, rate);
      return;
    }
    if (typeof window === "undefined") return;
    if (voiceIdentifier) {
      window.localStorage.setItem(BROWSER_VOICE_KEY, voiceIdentifier);
    } else {
      window.localStorage.removeItem(BROWSER_VOICE_KEY);
    }
    window.localStorage.setItem(
      BROWSER_RATE_KEY,
      Math.min(BROWSER_MAXIMUM_RATE, Math.max(BROWSER_MINIMUM_RATE, rate)).toString(),
    );
    setView({ status: "ready", state: browserState(), updating: false });
  }

  return { view, update, refresh };
}

export function browserReferenceSpeechPreferences(): {
  voiceIdentifier: string | null;
  rate: number;
} {
  if (typeof window === "undefined") {
    return { voiceIdentifier: null, rate: BROWSER_DEFAULT_RATE };
  }
  return {
    voiceIdentifier: window.localStorage.getItem(BROWSER_VOICE_KEY),
    rate: browserStoredRate(),
  };
}

export function browserSpeechRate(nativeRate: number): number {
  return Math.max(0.1, nativeRate / BROWSER_DEFAULT_RATE);
}
