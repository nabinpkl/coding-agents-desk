// The face a Bot wears, derived from where it stands in the roster.
//
// Its own module rather than a picture, a glyph or a generated avatar, and each of those was tried
// first. A lucide `Bot` is one drawing, so nine Bots wearing it are nine identical marks. A
// generated character (DiceBear's `voxel-bot`, measured on this roster at 24, 36 and 40px) varies
// its COLOUR across seeds and not its silhouette: eight Bots came back as the same box with the
// same screen, told apart only by a hue the panel was already saying twice. What an avatar has to
// do here is answer "which Bot is this" before the name under it is read, and only SHAPE does that
// once colour is spent.
//
// So the face is built from parts that change the outline: a head polygon, what stands on top of
// it, and the eyes. No mouth, because at 24px -- the size a session's mark is drawn at -- a mouth
// is two or three pixels that all five variants would spend on looking the same.
//
// Derived, never stored, for the reason `botSurface.ts` gives about colour: a face nobody chose is
// not an arrangement of this reader's, so it is not storage, and it is not a record the sidecar
// owns, so it is not a wire field either. It takes the same RANK the hue takes, which is what makes
// the two agree without either knowing about the other.

import type { CSSProperties } from "react";
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

/** A head outline, drawn in the 32x32 box every part of this face shares. */
const HEADS: readonly string[] = [
  // block
  "M7 8h18a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3Z",
  // hexagon, points left and right, so its widest line is the one the eyes sit on
  "M11 8h10l7 10-7 10H11L4 18Z",
  // pentagon, point up
  "M16 7 28 16l-4.5 12h-15L4 16Z",
  // taper, wide at the jaw
  "M9 8h14l5 20H4Z",
  // shield, point down
  "M4 9h24v11l-12 9-12-9Z",
  // octagon
  "M11 8h10l7 6v8l-7 6H11l-7-6v-8Z",
  // dome
  "M4 28v-9a12 11 0 0 1 24 0v9Z",
  // rhombus
  "M16 6l13 12-13 12L3 18Z",
];

/** What stands on the head. Empty is a variant, not a fallback. */
const TOPS: readonly (readonly string[])[] = [
  [],
  // one stalk with a lamp on it
  ["M15.1 3.4h1.8v6h-1.8Z", "M13.4 2.6a2.6 2.6 0 1 0 5.2 0 2.6 2.6 0 1 0-5.2 0Z"],
  // two ears, angled out
  ["M10.6 2.9 13 9.2l-2.2.9L8.4 3.8Z", "M21.4 2.9 19 9.2l2.2.9 2.4-6.3Z"],
  // a dish
  ["M6.5 9.2a9.5 9.5 0 0 1 19 0Z"],
];

/**
 * One eye, as a rounded box about its centre. A circle is the case where both radii and the corner
 * agree, which is what lets five variants share one element and one closing animation.
 */
interface Eye {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  round: number;
}

/** The eyes, which vary in shape AND in number: one eye is the strongest silhouette here. */
const EYES: readonly (readonly Eye[])[] = [
  // round
  [{ cx: 11, cy: 18, rx: 3.4, ry: 3.4, round: 3.4 }, { cx: 21, cy: 18, rx: 3.4, ry: 3.4, round: 3.4 }],
  // square
  [{ cx: 11, cy: 18, rx: 3.2, ry: 3.2, round: 1.1 }, { cx: 21, cy: 18, rx: 3.2, ry: 3.2, round: 1.1 }],
  // slits, tall
  [{ cx: 11.2, cy: 18, rx: 2.2, ry: 4.2, round: 2.2 }, { cx: 20.8, cy: 18, rx: 2.2, ry: 4.2, round: 2.2 }],
  // bands, wide
  [{ cx: 10.6, cy: 18, rx: 4.2, ry: 2.3, round: 2.3 }, { cx: 21.4, cy: 18, rx: 4.2, ry: 2.3, round: 2.3 }],
  // one eye
  [{ cx: 16, cy: 18, rx: 5.2, ry: 5.2, round: 5.2 }],
];

/**
 * How many Bots stand between one face and its repeat.
 *
 * The three strides below are each coprime to their own count, so every part cycles through all of
 * its variants rather than stalling on one, and the whole face repeats only when all three line up
 * again: lcm(8, 4, 5). Two Bots inside that run always differ in at least one part, and adjacent
 * ranks differ in all three.
 */
export const BOT_FACE_CYCLE = 40;

/** Which parts a rank draws. */
export interface BotFaceShape {
  head: string;
  top: readonly string[];
  eyes: readonly Eye[];
}

/**
 * The face at a given rank.
 *
 * The rank is the Bot's place in the roster ordered by creation, which is what `botCanvasHues`
 * ranks on and for the same three reasons it gives: taking a Bot off the canvas re-faces nothing,
 * a new Bot re-faces nothing, and a Bot keeps its face for as long as it exists.
 *
 * Negative or fractional input is floored into the cycle rather than rejected, because the only
 * thing a caller can do with a thrown error here is draw no face at all.
 */
export function botFaceOf(rank: number): BotFaceShape {
  const at = Math.abs(Math.floor(rank));
  return {
    head: HEADS[at % HEADS.length]!,
    top: TOPS[(at * 3) % TOPS.length]!,
    eyes: EYES[(at * 2) % EYES.length]!,
  };
}

/**
 * A Bot's face, on whatever disc it is placed in.
 *
 * Fills its parent rather than taking a size, the way the disc's initials do: the avatar is already
 * sized in one place (`size-6` for a session, `size-9` and `size-10` for a Bot) and a second number
 * here is a second place for those to disagree.
 *
 * The head takes `currentColor` and the eyes take the disc's own fill, so the eyes are holes rather
 * than ink. That is what keeps the contrast honest at every hue without measuring anything: what
 * shows through an eye is exactly the colour behind the face, and `styles.css` puts the head on the
 * rail's lightness, which is the furthest thing on the ladder from the disc it sits on.
 *
 * **Shut is the state, not a different face.** The eyes close by scaling, so the Bot a reader knows
 * is the Bot they are still looking at, and a blink is the same movement played briefly. Both live
 * in `styles.css` with the reduced-motion answer beside them.
 */
export function BotFace({ rank, shut = false, className = "" }: {
  rank: number;
  /** Eyes closed. The caller decides what that means; nothing here knows about the canvas. */
  shut?: boolean;
  className?: string;
}) {
  const face = botFaceOf(rank);
  return (
    <svg
      viewBox="0 0 32 32"
      className={`bot-face size-full ${className}`}
      // Decorative. The name it stands for is the next element in every row that draws it, and the
      // state its eyes carry is said in words by whatever control changed it.
      aria-hidden
      focusable="false"
    >
      {face.top.map((d) => <path key={d} d={d} fill="currentColor" />)}
      <path d={face.head} fill="currentColor" />
      <g
        className={`bot-face-eyes ${shut ? "bot-face-eyes--shut" : "bot-face-eyes--open"}`}
        // Each Bot blinks on its own phase, so a roster of them does not blink in chorus. Negative,
        // so a face starts partway through its cycle instead of every face opening on a blink.
        style={{ "--bot-face-blink-delay": `-${((rank * 1.37) % 7).toFixed(2)}s` } as CSSProperties}
      >
        {face.eyes.map((eye) => (
          <rect
            key={`${eye.cx}-${eye.cy}`}
            x={eye.cx - eye.rx}
            y={eye.cy - eye.ry}
            width={eye.rx * 2}
            height={eye.ry * 2}
            rx={eye.round}
            fill="var(--bot-face-socket)"
          />
        ))}
      </g>
    </svg>
  );
}
