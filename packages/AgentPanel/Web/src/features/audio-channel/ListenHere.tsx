"use client";

import { Headphones, LoaderCircle, X } from "lucide-react";
import { PROFILE_MENU_ITEM_CLASS } from "@/features/profile/PushMenuItems";
import {
  startListening,
  stopListening,
  useListenState,
  type ListenState,
} from "@/features/audio-channel/radioListener";

/** What the menu entry says for each phase, and whether a press starts or stops. */
function entry(state: ListenState): { label: string; starts: boolean } {
  switch (state.phase) {
    case "starting":
      return { label: "Starting to listen…", starts: false };
    case "listening":
      return { label: "Stop listening here", starts: false };
    case "reconnecting":
      return { label: "Reconnecting to Agent Radio…", starts: false };
    case "resume":
      return { label: "Listen here again", starts: true };
    default:
      return { label: "Listen to Agent Radio here", starts: true };
  }
}

/**
 * The Profile menu's switch for hearing Agent Radio in this tab (`radioListener.ts`), beside the
 * link to its own page. Its press is the tap iOS needs to start a page's audio.
 */
export function ListenHereMenuItem() {
  const state = useListenState();
  const { label, starts } = entry(state);
  const busy = state.phase === "starting" || state.phase === "reconnecting";
  return (
    <button
      type="button"
      role="menuitem"
      onClick={starts ? startListening : stopListening}
      title={state.detail ?? label}
      className={PROFILE_MENU_ITEM_CLASS}
    >
      {busy ? (
        <LoaderCircle className="size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        <Headphones className={`size-4 shrink-0 ${state.phase === "listening" ? "text-primary" : ""}`} aria-hidden />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {state.phase === "failed" ? <span className="shrink-0 text-xs text-destructive">Failed</span> : null}
    </button>
  );
}

/**
 * What listening here needs from the reader, floated over the canvas so it moves nothing, and gone
 * the moment it is answered: the tap that starts listening again after a reload ended it, since iOS
 * starts a page's audio only from a tap.
 */
export function ListenNotice() {
  const state = useListenState();
  if (state.phase !== "resume") return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div
        role="status"
        className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-card py-1 pr-1 pl-1 font-medium text-foreground shadow-lg shadow-black/25 ring-1 ring-black/5"
        style={{ fontSize: "var(--agent-panel-fs-sidebar-body, 15px)" }}
      >
        <button
          type="button"
          onClick={startListening}
          className="flex items-center gap-2 rounded-full px-3 py-1 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary active:bg-accent/80"
        >
          <Headphones className="size-[1.1em] text-primary" aria-hidden />
          Keep listening to Agent Radio
        </button>
        <button
          type="button"
          onClick={stopListening}
          aria-label="Stop listening"
          className="inline-flex size-[1.9em] items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-accent/80"
        >
          <X className="size-[1em]" aria-hidden />
        </button>
      </div>
    </div>
  );
}
