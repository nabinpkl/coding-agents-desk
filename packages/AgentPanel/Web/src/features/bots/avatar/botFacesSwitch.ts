// The switch between a Bot's generated face and its initials, remembered with the sidebar's
// preferences. Apart from the faces themselves: what a face looks like does not depend on whether
// faces are on.

import { useSyncExternalStore } from "react";
import { loadSidebarPreferences, storeSidebarPreferences } from "@/features/sidebar/sidebarPreferences";

const faceListeners = new Set<() => void>();
let facesOn = loadSidebarPreferences().botFaces;

/**
 * Whether Bots wear their generated faces instead of their initials.
 *
 * One store for every surface that draws an avatar -- the two roster mounts and the canvas cards
 * -- so the switch and every face move together. The module holds the value for rendering,
 * storage holds the record, and the one setter below writes storage first. It re-reads before
 * writing, because two tabs on this origin are ordinary and a press that wrote its own copy back
 * would erase what the other tab had arranged.
 */
export function useBotFaces(): boolean {
  return useSyncExternalStore(
    (listener) => {
      faceListeners.add(listener);
      return () => {
        faceListeners.delete(listener);
      };
    },
    () => facesOn,
    () => false,
  );
}

/** Flips the faces switch. The roster header holds its one control. */
export function setBotFaces(on: boolean): void {
  storeSidebarPreferences({ ...loadSidebarPreferences(), botFaces: on });
  if (facesOn === on) return;
  facesOn = on;
  for (const listener of faceListeners) listener();
}
