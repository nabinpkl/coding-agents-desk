import {
  INTERACTION_HANDLER,
  isEmbedded,
  postToHost,
} from "@/lib/host-bridge";
import {
  browserReferenceSpeechPreferences,
  browserSpeechRate,
  REFERENCE_SPEECH_LANGUAGE,
} from "@/features/voice/reference-speech-settings";

export const MAX_REFERENCE_SPEECH_UTF8_BYTES = 20_000;

function normalizedReferenceText(text: string): string {
  const normalized = text.trim();
  if (normalized.length === 0) {
    throw new Error("Reference speech needs text.");
  }
  if (
    new TextEncoder().encode(normalized).length >
    MAX_REFERENCE_SPEECH_UTF8_BYTES
  ) {
    throw new Error("Reference speech is too long.");
  }
  return normalized;
}

export function speakReference(text: string): void {
  const normalized = normalizedReferenceText(text);
  if (isEmbedded()) {
    postToHost(INTERACTION_HANDLER, {
      t: "referenceSpeech",
      text: normalized,
      language: REFERENCE_SPEECH_LANGUAGE,
    });
    return;
  }

  if (
    typeof window === "undefined" ||
    typeof window.speechSynthesis === "undefined" ||
    typeof SpeechSynthesisUtterance === "undefined"
  ) {
    throw new Error("Reference speech is unavailable in this browser.");
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(normalized);
  utterance.lang = REFERENCE_SPEECH_LANGUAGE;
  const preferences = browserReferenceSpeechPreferences();
  utterance.voice =
    window.speechSynthesis
      .getVoices()
      .find((voice) => voice.voiceURI === preferences.voiceIdentifier) ?? null;
  utterance.rate = browserSpeechRate(preferences.rate);
  window.speechSynthesis.speak(utterance);
}

export function stopReferenceSpeech(): void {
  if (isEmbedded()) {
    postToHost(INTERACTION_HANDLER, { t: "referenceSpeechStop" });
    return;
  }
  if (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined"
  ) {
    window.speechSynthesis.cancel();
  }
}
