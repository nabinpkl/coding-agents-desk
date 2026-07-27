import {
  INTERACTION_HANDLER,
  isEmbedded,
  postToHost,
} from "@/lib/host-bridge";

export const REFERENCE_SPEECH_LANGUAGE = "en-US";
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
