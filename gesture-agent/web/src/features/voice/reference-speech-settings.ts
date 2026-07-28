"use client";

import { useCallback, useEffect, useState } from "react";

import { getReferenceSpeechState } from "@/lib/api";
import type { ReferenceSpeechState } from "@/lib/wire";

const VOICE_KEY = "agentDesk.referenceSpeech.kokoroVoiceIdentifier";
const SPEED_KEY = "agentDesk.referenceSpeech.kokoroSpeed";

export interface ReferenceSpeechPreferences {
  voiceIdentifier: string;
  speed: number;
}

export type ReferenceSpeechSettingsView =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      state: ReferenceSpeechState;
      preferences: ReferenceSpeechPreferences;
    };

function storedPreferences(
  state: ReferenceSpeechState,
): ReferenceSpeechPreferences {
  const storedVoice =
    typeof window === "undefined" ? null : window.localStorage.getItem(VOICE_KEY);
  const voiceIdentifier = state.voices.some(
    (voice) => voice.identifier === storedVoice,
  )
    ? (storedVoice as string)
    : state.defaultVoiceIdentifier;
  if (storedVoice && storedVoice !== voiceIdentifier) {
    window.localStorage.removeItem(VOICE_KEY);
  }

  const storedSpeed =
    typeof window === "undefined"
      ? Number.NaN
      : Number(window.localStorage.getItem(SPEED_KEY));
  const speed = Number.isFinite(storedSpeed)
    ? Math.min(
        state.speed.maximum,
        Math.max(state.speed.minimum, storedSpeed),
      )
    : state.speed.defaultValue;
  return { voiceIdentifier, speed };
}

export function useReferenceSpeechSettings(): {
  view: ReferenceSpeechSettingsView;
  update: (voiceIdentifier: string, speed: number) => void;
  refresh: () => void;
} {
  const [view, setView] = useState<ReferenceSpeechSettingsView>({
    status: "loading",
  });

  const refresh = useCallback(() => {
    setView((existing) =>
      existing.status === "ready" ? existing : { status: "loading" },
    );
    void getReferenceSpeechState()
      .then((state) => {
        setView({
          status: "ready",
          state,
          preferences: storedPreferences(state),
        });
      })
      .catch((error: unknown) => {
        setView({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "The Mac reference voice service is unavailable.",
        });
      });
  }, []);

  useEffect(() => {
    refresh();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () =>
      document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [refresh]);

  function update(voiceIdentifier: string, speed: number): void {
    if (
      view.status !== "ready" ||
      !view.state.voices.some((voice) => voice.identifier === voiceIdentifier) ||
      !Number.isFinite(speed)
    ) {
      throw new Error("Reference speech preferences are invalid.");
    }
    const clampedSpeed = Math.min(
      view.state.speed.maximum,
      Math.max(view.state.speed.minimum, speed),
    );
    window.localStorage.setItem(VOICE_KEY, voiceIdentifier);
    window.localStorage.setItem(SPEED_KEY, clampedSpeed.toFixed(2));
    setView({
      ...view,
      preferences: { voiceIdentifier, speed: clampedSpeed },
    });
  }

  return { view, update, refresh };
}
