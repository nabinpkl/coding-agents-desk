// How tall this reader wants the trackpad deck: the pad and the scroll strip beside it, which
// share one height because they sit in one row.
//
// Kept as a share of the viewer rather than in pixels, because the same phone is a tall viewer
// held upright and a short one turned sideways, and a deck sized for the first would bury the
// picture in the second. Stored for the reason the gesture tuning is, a value set by hand that a
// reload would otherwise throw away, and persisted the same way (ADR-0114): validated on the way
// in, so a stale or hand-edited share falls back to the default.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** The deck's share of the viewer's height until the reader picks one. */
export const DEFAULT_DECK_SHARE = 0.38;
/** The slider's range. The top keeps at least two fifths of the viewer for the picture. */
export const DECK_SHARE_MIN = 0.2;
export const DECK_SHARE_MAX = 0.6;
export const DECK_HEIGHT_STORAGE_KEY = "agentdesk.desktop.trackpadDeckHeight";

export function validDeckShare(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= DECK_SHARE_MIN && value <= DECK_SHARE_MAX
    ? value
    : DEFAULT_DECK_SHARE;
}

interface DeckHeightStore {
  deckShare: number;
  setDeckShare: (share: number) => void;
  resetDeckShare: () => void;
}

export const useDeckHeight = create<DeckHeightStore>()(
  persist(
    (set) => ({
      deckShare: DEFAULT_DECK_SHARE,
      setDeckShare: (share) => set({ deckShare: validDeckShare(share) }),
      resetDeckShare: () => set({ deckShare: DEFAULT_DECK_SHARE }),
    }),
    {
      name: DECK_HEIGHT_STORAGE_KEY,
      version: 1,
      // A private window and a container without storage both throw; the share then lives for the
      // session only.
      storage: createJSONStorage(() => window.localStorage),
      partialize: ({ deckShare }) => ({ deckShare }),
      merge: (persisted, current) => ({
        ...current,
        deckShare: validDeckShare((persisted as { deckShare?: unknown } | undefined)?.deckShare),
      }),
    },
  ),
);
