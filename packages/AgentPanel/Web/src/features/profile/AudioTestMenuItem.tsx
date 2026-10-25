// The Profile menu's audio test entries: start the hour-long stream, pause and resume it, stop it.
//
// The player itself is `audioTestPlayer.ts`, outside React, so the test outlives this menu; the
// menu reads where it got to when it is opened again.

import { useSyncExternalStore } from "react";
import { Pause, Play, Square, Volume2 } from "lucide-react";
import {
  audioTestState,
  pauseAudioTest,
  resumeAudioTest,
  startAudioTest,
  stopAudioTest,
  subscribeAudioTest,
} from "@/features/profile/audioTestPlayer";
import { PROFILE_MENU_ITEM_CLASS } from "@/features/profile/PushMenuItems";

export function AudioTestMenuItem() {
  const test = useSyncExternalStore(subscribeAudioTest, audioTestState);
  const running = test.phase === "starting" || test.phase === "playing";
  const held = test.phase === "paused";
  const primary = running
    ? { label: "Pause audio test", icon: Pause, act: pauseAudioTest }
    : held
      ? { label: "Resume audio test", icon: Play, act: resumeAudioTest }
      : { label: "Test audio stream", icon: Volume2, act: startAudioTest };
  const Icon = primary.icon;
  return (
    <>
      <button type="button" role="menuitem" onClick={primary.act} className={PROFILE_MENU_ITEM_CLASS}>
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{primary.label}</span>
        {!running && !held ? <span className="shrink-0 text-xs text-muted-foreground">1 hr</span> : null}
      </button>
      {running || held ? (
        <button type="button" role="menuitem" onClick={stopAudioTest} className={PROFILE_MENU_ITEM_CLASS}>
          <Square className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Stop audio test</span>
        </button>
      ) : null}
      {test.status ? (
        <p role="status" className="border-t border-border px-3 py-1.5 text-xs break-words text-muted-foreground">
          {test.status}
        </p>
      ) : null}
    </>
  );
}
