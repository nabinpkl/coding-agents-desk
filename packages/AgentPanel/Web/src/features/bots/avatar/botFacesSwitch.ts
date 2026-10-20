// The switch between a Bot's generated face and its initials, remembered with the sidebar's
// preferences. Apart from the faces themselves: what a face looks like does not depend on whether
// faces are on.

import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { loadSidebarPreferences, storeSidebarPreferences } from "@/features/sidebar/sidebarPreferences";

const store = createStore<{ facesOn: boolean }>(() => ({ facesOn: loadSidebarPreferences().botFaces }));

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
  return useStore(store, (state) => state.facesOn);
}

/** Flips the faces switch. The roster header holds its one control. */
export function setBotFaces(on: boolean): void {
  storeSidebarPreferences({ ...loadSidebarPreferences(), botFaces: on });
  if (store.getState().facesOn !== on) store.setState({ facesOn: on });
}
