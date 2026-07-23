import { Activity, AudioLines, Hand, type LucideIcon } from "lucide-react";

export interface AppRoute {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

/**
 * The three primary product surfaces. Single source of truth for both the
 * global nav and the home page cards so their labels and icons never drift.
 */
export const appRoutes: readonly AppRoute[] = [
  {
    href: "/gesture",
    label: "Gesture",
    description:
      "Client-side hand and face landmark tracking, inferred entirely in the browser via MediaPipe.",
    icon: Hand,
  },
  {
    href: "/voice",
    label: "Voice",
    description:
      "Capture the mic, stream PCM to the Python backend, and watch live server-side ASR transcribe as you speak.",
    icon: AudioLines,
  },
  {
    href: "/analysis",
    label: "Analysis",
    description:
      "Inspect saved recordings, run signal analysis, and compare pronunciation against a reference take.",
    icon: Activity,
  },
] as const;
