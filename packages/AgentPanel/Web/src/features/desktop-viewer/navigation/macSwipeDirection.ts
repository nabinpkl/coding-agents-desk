// Which way a swipe along the desktops row moves: this repo's default (finger right brings the
// left neighbour, the row read as a scrollbar), or the Mac's own.
//
// A store rather than state in the row, because the row reads it and the viewer's settings
// popover sets it, and those are two components that share no parent short of the viewer. Kept
// under the key and the bare "true"/"false" the row always wrote, so a reader's choice survives
// the move.

import { create } from "zustand";

export const MAC_SWIPE_DIRECTION_KEY = "agentdesk.desktop-mac-direction";

function stored(): { macDirection: boolean; storageFailed: boolean } {
  try {
    return { macDirection: localStorage.getItem(MAC_SWIPE_DIRECTION_KEY) === "true", storageFailed: false };
  } catch {
    return { macDirection: false, storageFailed: true };
  }
}

interface MacSwipeDirectionStore {
  macDirection: boolean;
  /** The last read or write threw, so the choice lasts only as long as this page. */
  storageFailed: boolean;
  setMacDirection: (macDirection: boolean) => void;
}

export const useMacSwipeDirection = create<MacSwipeDirectionStore>()((set) => ({
  ...stored(),
  setMacDirection: (macDirection) => {
    try {
      localStorage.setItem(MAC_SWIPE_DIRECTION_KEY, String(macDirection));
      set({ macDirection });
    } catch {
      set({ macDirection, storageFailed: true });
    }
  },
}));
