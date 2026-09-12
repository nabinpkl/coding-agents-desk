"use client";

import { Keyboard as KeyboardIcon } from "lucide-react";
import {
  CHARACTER_PREVIEW,
  characterPreviewPath,
  type CharacterPreviewLayout,
} from "@/features/desktop-viewer/keyboardDeckMetrics";
import {
  deckKeyId,
  deckKeyLabel,
  deckKeyName,
  isSpecialKey,
  keyWidthWeight,
  type DeckKey,
  type KeyboardDeckState,
} from "@/features/desktop-viewer/keyboardDeckModel";

/**
 * Resting and pressed fills, from `KeyboardKeyAppearance.swift`. The pairs invert by theme: a
 * light key darkens under the finger, a dark key lightens. Getting that backwards is the single
 * most visible way to look almost-but-not-like the iPhone keyboard.
 */
const REGULAR_FILL = "bg-white data-[pressed=true]:bg-[#d1d1d1] "
  + "dark:bg-[#737373] dark:data-[pressed=true]:bg-[#949494]";
const SPECIAL_FILL = "bg-[#bababa] data-[pressed=true]:bg-[#9e9e9e] "
  + "dark:bg-[#474747] dark:data-[pressed=true]:bg-[#666666]";
/** Pressed shadows are the resting ones at 0.35 opacity, shallower and tighter. */
const REGULAR_SHADOW = "shadow-[0_1.5px_0.75px_rgba(0,0,0,0.28)] "
  + "data-[pressed=true]:shadow-[0_0.5px_0.25px_rgba(0,0,0,0.098)] "
  + "dark:shadow-[0_1.5px_0.75px_rgba(0,0,0,0.62)] "
  + "dark:data-[pressed=true]:shadow-[0_0.5px_0.25px_rgba(0,0,0,0.217)]";
/**
 * An armed or locked shift washes the keycap in the tint colour rather than taking either special
 * fill, which is `isActiveSpecial` in `KeyboardKeyButton.applyVisualState`. The alpha is the whole
 * effect: the deck shows through, so the key reads as lit rather than as a different key.
 */
const ACTIVE_FILL = "bg-[rgba(0,122,255,0.42)] data-[pressed=true]:bg-[rgba(0,122,255,0.62)]";
const SPECIAL_SHADOW = "shadow-[0_1.5px_0.75px_rgba(0,0,0,0.30)] "
  + "data-[pressed=true]:shadow-[0_0.5px_0.25px_rgba(0,0,0,0.105)] "
  + "dark:shadow-[0_1.5px_0.75px_rgba(0,0,0,0.68)] "
  + "dark:data-[pressed=true]:shadow-[0_0.5px_0.25px_rgba(0,0,0,0.238)]";

function titleSize(key: DeckKey): number {
  switch (key.kind) {
    case "return":
      return 24;
    case "page":
      return 18;
    case "native":
      return 20;
    case "space":
      return 16;
    default:
      return 22;
  }
}

/**
 * One keycap.
 *
 * Presentational only, which is why every touch is left to the deck: the deck resolves a touch to
 * a tiled cell rather than to an element, so where a key is DRAWN and where it is HIT are two
 * different questions and this answers the first.
 */
export function DeckKeycap({
  deckKey,
  state,
  pressed,
  centred,
  widened,
  outerGap,
}: {
  deckKey: DeckKey;
  state: KeyboardDeckState;
  pressed: boolean;
  centred: boolean;
  widened: boolean;
  outerGap: number;
}) {
  const special = isSpecialKey(deckKey);
  const lit = deckKey.kind === "shift" && state.shift !== "off";
  const id = deckKeyId(deckKey);
  return (
    <button
      type="button"
      data-testid={`deck-key-${id}`}
      data-pressed={pressed}
      aria-label={deckKeyName(deckKey)}
      // Tri-state, matching the accessibility value iOS sets: armed for one letter
      // reads as partial, caps lock as fully on.
      aria-pressed={deckKey.kind === "shift"
        ? (state.shift === "locked" ? true : state.shift === "on" ? "mixed" : false)
        : undefined}
      data-shift={deckKey.kind === "shift" ? state.shift : undefined}
      // Presentational: the deck resolves touches to tiled cells, so the keycap is
      // where the key is drawn, not where it is hit. Left focusable and labelled for
      // assistive technology, which still drives the element rather than a point.
      tabIndex={-1}
      style={{
        fontSize: titleSize(deckKey),
        marginLeft: widened ? outerGap : undefined,
        ...(centred
          ? { width: "var(--kbd-key-w)", flex: "none" }
          : { flexGrow: keyWidthWeight(deckKey), flexBasis: 0, minWidth: 0 }),
      }}
      // `touch-action` does not inherit, so the deck's own value does not reach the
      // keys: without this a press that drifts scrolls the page instead of typing.
      // `pointer-events-none` keeps every touch on the deck, where the cells decide.
      className={`pointer-events-none touch-none rounded-lg leading-none text-black transition-none dark:text-white
        data-[pressed=true]:translate-y-px
        focus-visible:outline-2 focus-visible:outline-ring
        ${lit ? ACTIVE_FILL : special ? SPECIAL_FILL : REGULAR_FILL}
        ${special ? SPECIAL_SHADOW : REGULAR_SHADOW}`}
    >
      {deckKey.kind === "native"
        ? <KeyboardIcon aria-hidden size={22} className="mx-auto" />
        : deckKeyLabel(deckKey, state)}
    </button>
  );
}

/** The balloon over a character key, which the Swift draws as one path rather than a rounded box. */
export function DeckKeyPreview({
  layout,
  character,
}: {
  layout: CharacterPreviewLayout;
  character: string;
}) {
  return (
    <div
      aria-hidden
      data-testid="deck-key-preview"
      className="pointer-events-none absolute"
      style={{
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
      }}
    >
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="absolute inset-0 drop-shadow-[0_2px_2px_rgba(0,0,0,0.30)] dark:drop-shadow-[0_2px_2px_rgba(0,0,0,0.72)]"
      >
        <path
          d={characterPreviewPath(layout.width, layout.height, layout.tipX)}
          className="fill-white dark:fill-[#8c8c8c]"
        />
      </svg>
      <span
        className="absolute inset-x-0 text-center text-black dark:text-white"
        style={{
          top: 2,
          fontSize: 34,
          lineHeight: `${CHARACTER_PREVIEW.bubbleHeight - 4}px`,
        }}
      >
        {character}
      </span>
    </div>
  );
}
