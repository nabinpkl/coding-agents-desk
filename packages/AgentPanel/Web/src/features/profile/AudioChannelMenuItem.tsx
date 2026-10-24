// The Profile menu's audio channel entries: listen to what agents say, pause and resume, stop.
//
// The player itself is `audioChannelPlayer.ts`, outside React, so listening outlives this menu; the
// menu reads where it got to when it is opened again.

import { useSyncExternalStore } from "react";
import { Pause, Play, Square, Volume2 } from "lucide-react";
import {
  audioChannelState,
  pauseListening,
  resumeListening,
  startListening,
  stopListening,
  subscribeAudioChannel,
} from "@/features/profile/audioChannelPlayer";
import { PROFILE_MENU_ITEM_CLASS } from "@/features/profile/PushMenuItems";

export function AudioChannelMenuItem() {
  const channel = useSyncExternalStore(subscribeAudioChannel, audioChannelState);
  const running = channel.phase === "starting" || channel.phase === "playing";
  const held = channel.phase === "paused";
  const primary = running
    ? { label: "Pause listening", icon: Pause, act: pauseListening }
    : held
      ? { label: "Resume listening", icon: Play, act: resumeListening }
      : { label: "Listen to agents", icon: Volume2, act: startListening };
  const Icon = primary.icon;
  return (
    <>
      <button type="button" role="menuitem" onClick={primary.act} className={PROFILE_MENU_ITEM_CLASS}>
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{primary.label}</span>
      </button>
      {running || held ? (
        <button type="button" role="menuitem" onClick={stopListening} className={PROFILE_MENU_ITEM_CLASS}>
          <Square className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Stop listening</span>
        </button>
      ) : null}
      {channel.status ? (
        <p role="status" className="border-t border-border px-3 py-1.5 text-xs break-words text-muted-foreground">
          {channel.status}
        </p>
      ) : null}
    </>
  );
}
