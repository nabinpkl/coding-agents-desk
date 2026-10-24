// The Profile menu's audio channel entries: listen to what agents say, pause and resume, stop, and
// which bed of noise plays under them on this device, and how loud.
//
// The player itself is `audioChannelPlayer.ts`, outside React, so listening outlives this menu; the
// menu reads where it got to when it is opened again.

import { useSyncExternalStore } from "react";
import { Pause, Play, Square, Volume2 } from "lucide-react";
import { AUDIO_NOISE_COLORS, AUDIO_NOISE_LEVEL_MAX } from "@agentdesk/agent-feed-wire";
import {
  audioChannelState,
  pauseListening,
  resumeListening,
  setNoiseColor,
  setNoiseLevel,
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
      {/* Set before listening too, so the first second already sounds right. Left and right change
          it; up and down still walk the menu. */}
      <label className="flex items-center gap-3 border-t border-border px-3 py-2 text-sm">
        <span className="shrink-0">Noise</span>
        <input
          type="range"
          min={0}
          max={AUDIO_NOISE_LEVEL_MAX}
          step={1}
          value={channel.noise}
          onChange={(event) => setNoiseLevel(Number(event.target.value))}
          aria-label="Noise level"
          aria-valuetext={channel.noise === 0 ? "off" : `${channel.noise} of ${AUDIO_NOISE_LEVEL_MAX}`}
          className="min-w-0 flex-1 cursor-pointer accent-primary focus-visible:outline-2 focus-visible:outline-offset-2
            focus-visible:outline-primary"
        />
        <span className="w-6 shrink-0 text-right tabular-nums">{channel.noise === 0 ? "off" : channel.noise}</span>
      </label>
      <div role="radiogroup" aria-label="Noise color" className="flex gap-1 border-t border-border px-3 py-2">
        {AUDIO_NOISE_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={channel.color === color}
            onClick={() => setNoiseColor(color)}
            className="flex-1 rounded-md border border-border px-2 py-1 text-xs capitalize transition-colors
              hover:bg-accent hover:text-accent-foreground active:bg-accent/80 focus-visible:outline-2
              focus-visible:outline-offset-1 focus-visible:outline-primary aria-checked:border-primary
              aria-checked:bg-primary aria-checked:text-primary-foreground"
          >
            {color}
          </button>
        ))}
      </div>
      {channel.status ? (
        <p role="status" className="border-t border-border px-3 py-1.5 text-xs break-words text-muted-foreground">
          {channel.status}
        </p>
      ) : null}
    </>
  );
}
