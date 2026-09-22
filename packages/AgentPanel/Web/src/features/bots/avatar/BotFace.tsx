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
// So the faces are a SET, drawn by hand rather than generated, and three rules hold it together.
// Each one replaced a failure of the generated hundred that came before it:
//
// - **One outline class per head.** Heads differ by side count, aspect, where the width sits and
//   how the corners are cut. They never differ by a fraction of a unit, which is all the generated
//   set varied: it held seven "squares" within 0.6 of a unit of each other, under a pixel apart at
//   the size any of them is drawn, and four ovals the same. Distinctness has to be perceptual, and
//   a filter that only asks whether two paths are unequal does not ask that.
// - **One object.** Whatever stands on a head is drawn from deep inside it, sharing its fill, so
//   the two are one silhouette with a detail on it rather than a body with a second body balanced
//   on top. Nothing in the set is as wide as the head under it, and nothing can float off a short
//   head, because a top that starts below the outline has no edge to come away from.
// - **Eyes belong to the head.** Each head carries the span its own eyes sit on, so a narrow head
//   does not wear a wide head's stations and push an eye through its own outline. Every pair in
//   the set was checked in a browser with `isPointInFill`, sampling each eye's outline rather than
//   its centre, and every top was checked to overlap the head it stands on.
//
// No mouth: at the size a session's mark is drawn a mouth is two or three pixels that every
// variant would spend on looking the same.
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

/**
 * Twenty-five outlines, each a different class of shape rather than a different set of numbers.
 *
 * `span` is the head's own eye station: half the distance between two eye centres, set from how
 * wide that head actually is on the eye line. It is why one set of five eye shapes can serve all
 * twenty-four without an eye ever hanging off an edge.
 *
 * Frozen literals, so nothing runs at load and what a Bot wears can never move under it.
 */
const HEADS: readonly { span: number; d: string }[] = [
  { span: 4.7, d: "M5 7.3Q5 6.5 5.8 6.5L26.2 6.5Q27 6.5 27 7.3L27 26.7Q27 27.5 26.2 27.5L5.8 27.5Q5 27.5 5 26.7Z" }, // block-sharp
  { span: 4.7, d: "M5 13.5Q5 6.5 12 6.5L20 6.5Q27 6.5 27 13.5L27 20.5Q27 27.5 20 27.5L12 27.5Q5 27.5 5 20.5Z" }, // block-round
  { span: 3.9, d: "M7.2 8Q7.2 5 10.2 5L21.8 5Q24.8 5 24.8 8L24.8 26Q24.8 29 21.8 29L10.2 29Q7.2 29 7.2 26Z" }, // tall
  { span: 5.5, d: "M3 12Q3 9 6 9L26 9Q29 9 29 12L29 22Q29 25 26 25L6 25Q3 25 3 22Z" }, // wide
  { span: 4.5, d: "M5.2 17A10.8 10.8 0 0 1 26.8 17A10.8 10.8 0 0 1 5.2 17Z" }, // circle
  { span: 3.9, d: "M7.2 17A8.8 12 0 0 1 24.8 17A8.8 12 0 0 1 7.2 17Z" }, // oval-tall
  { span: 5.4, d: "M3 17A13 8.2 0 0 1 29 17A13 8.2 0 0 1 3 17Z" }, // oval-wide
  { span: 3.8, d: "M7.4 10.73Q7.4 5 13.13 5L18.87 5Q24.6 5 24.6 10.73L24.6 23.27Q24.6 29 18.87 29L13.13 29Q7.4 29 7.4 23.27Z" }, // capsule-tall
  { span: 5.5, d: "M3 14.5Q3 9.5 8 9.5L24 9.5Q29 9.5 29 14.5L29 19.5Q29 24.5 24 24.5L8 24.5Q3 24.5 3 19.5Z" }, // capsule-wide
  { span: 4.4, d: "M5.5 27.5L5.5 17A10.5 10.5 0 0 1 26.5 17L26.5 27.5Z" }, // dome
  { span: 4.4, d: "M5.5 6.5L26.5 6.5L26.5 17A10.5 10.5 0 0 1 5.5 17Z" }, // bowl
  { span: 4.6, d: "M8 8.85Q8.5 6.5 10.9 6.5L21.1 6.5Q23.5 6.5 24 8.85L27.5 25.15Q28 27.5 25.6 27.5L6.4 27.5Q4 27.5 4.5 25.15Z" }, // trapezoid
  { span: 4.4, d: "M4.5 8.85Q4 6.5 6.4 6.5L25.6 6.5Q28 6.5 27.5 8.85L24 25.15Q23.5 27.5 21.1 27.5L10.9 27.5Q8.5 27.5 8 25.15Z" }, // wedge
  { span: 4.9, d: "M9.07 8.27Q10 6.5 12 6.5L20 6.5Q22 6.5 22.93 8.27L26.57 15.23Q27.5 17 26.57 18.77L22.93 25.73Q22 27.5 20 27.5L12 27.5Q10 27.5 9.07 25.73L5.43 18.77Q4.5 17 5.43 15.23Z" }, // hex-flat
  { span: 4.4, d: "M14.3 6.55Q16 5.5 17.7 6.55L24.8 10.95Q26.5 12 26.5 14L26.5 20Q26.5 22 24.8 23.05L17.7 27.45Q16 28.5 14.3 27.45L7.2 23.05Q5.5 22 5.5 20L5.5 14Q5.5 12 7.2 10.95Z" }, // hex-point
  { span: 4.2, d: "M14.3 6.89Q16 5.5 17.7 6.89L25.3 13.11Q27 14.5 26.43 16.62L24.07 25.38Q23.5 27.5 21.3 27.5L10.7 27.5Q8.5 27.5 7.93 25.38L5.57 16.62Q5 14.5 6.7 13.11Z" }, // pentagon
  { span: 4.7, d: "M10.01 7.49Q11 6.5 12.4 6.5L19.6 6.5Q21 6.5 21.99 7.49L26.01 11.51Q27 12.5 27 13.9L27 20.1Q27 21.5 26.01 22.49L21.99 26.51Q21 27.5 19.6 27.5L12.4 27.5Q11 27.5 10.01 26.51L5.99 22.49Q5 21.5 5 20.1L5 13.9Q5 12.5 5.99 11.51Z" }, // octagon
  { span: 4.2, d: "M13.92 7.17Q16 5 18.08 7.17L25.42 14.83Q27.5 17 25.42 19.17L18.08 26.83Q16 29 13.92 26.83L6.58 19.17Q4.5 17 6.58 14.83Z" }, // diamond
  { span: 4.6, d: "M5 9.1Q5 6.5 7.6 6.5L24.4 6.5Q27 6.5 27 9.1L27 16.4Q27 19 25.03 20.7L17.97 26.8Q16 28.5 14.03 26.8L6.97 20.7Q5 19 5 16.4Z" }, // shield
  { span: 4.7, d: "M14.14 5.68Q16 4.5 17.86 5.68L25.14 10.32Q27 11.5 27 13.7L27 25.3Q27 27.5 24.8 27.5L7.2 27.5Q5 27.5 5 25.3L5 13.7Q5 11.5 6.86 10.32Z" }, // roof
  { span: 4.3, d: "M6.5 7L25.5 7Q28.5 17 25.5 27L6.5 27Q3.5 17 6.5 7Z" }, // barrel
  { span: 4.2, d: "M15.18 6.13Q16 5 16.82 6.13L19.53 9.88Q20.35 11.01 21.68 11.44L26.08 12.86Q27.41 13.29 26.59 14.42L23.86 18.16Q23.04 19.29 23.04 20.69L23.05 25.31Q23.05 26.71 21.72 26.27L17.33 24.84Q16 24.4 14.67 24.84L10.28 26.27Q8.95 26.71 8.95 25.31L8.96 20.69Q8.96 19.29 8.14 18.16L5.41 14.42Q4.59 13.29 5.92 12.86L10.32 11.44Q11.65 11.01 12.47 9.88Z" }, // star
  { span: 4.4, d: "M15.36 6.17Q16 5.4 16.64 6.17L18.57 8.47Q19.21 9.24 20.21 9.15L23.21 8.89Q24.2 8.8 24.11 9.79L23.85 12.79Q23.76 13.79 24.53 14.43L26.83 16.36Q27.6 17 26.83 17.64L24.53 19.57Q23.76 20.21 23.85 21.21L24.11 24.21Q24.2 25.2 23.21 25.11L20.21 24.85Q19.21 24.76 18.57 25.53L16.64 27.83Q16 28.6 15.36 27.83L13.43 25.53Q12.79 24.76 11.79 24.85L8.79 25.11Q7.8 25.2 7.89 24.21L8.15 21.21Q8.24 20.21 7.47 19.57L5.17 17.64Q4.4 17 5.17 16.36L7.47 14.43Q8.24 13.79 8.15 12.79L7.89 9.79Q7.8 8.8 8.79 8.89L11.79 9.15Q12.79 9.24 13.43 8.47Z" }, // burst
  { span: 4.3, d: "M10.1 7.57Q10.1 5.8 11.87 5.8L20.13 5.8Q21.9 5.8 21.9 7.57L21.9 9.33Q21.9 11.1 23.67 11.1L25.43 11.1Q27.2 11.1 27.2 12.87L27.2 21.13Q27.2 22.9 25.43 22.9L23.67 22.9Q21.9 22.9 21.9 24.67L21.9 26.43Q21.9 28.2 20.13 28.2L11.87 28.2Q10.1 28.2 10.1 26.43L10.1 24.67Q10.1 22.9 8.33 22.9L6.57 22.9Q4.8 22.9 4.8 21.13L4.8 12.87Q4.8 11.1 6.57 11.1L8.33 11.1Q10.1 11.1 10.1 9.33Z" }, // cross
  { span: 4.2, d: "M16 4C22.08 10.5 25.8 15.5 25.8 18.2A9.8 9.8 0 1 1 6.2 18.2C6.2 15.5 9.92 10.5 16 4Z" }, // teardrop
];

/**
 * What stands on a head, and the reason each one reaches so far down.
 *
 * Every top is drawn from four units above the head's centre, which is inside every outline in the
 * set, up to above its ceiling. The buried part shares the head's fill and is simply not visible,
 * and the join it makes is not a join at all: there is no seam to open at any size, and no short
 * head a top can float above. Two of the four sit off the centre line, so the heads that already
 * come to a point there -- diamond, star, roof, pentagon -- cannot swallow them.
 */
const TOPS: readonly (readonly string[])[] = [
  [], // bare
  [
    "M15.25 3.9h1.5v9.1h-1.5Z",
    "M13.8 3.5a2.2 2.2 0 1 0 4.4 0 2.2 2.2 0 1 0-4.4 0Z",
  ], // stalk
  [
    "M7.4 4.3l2.2 4-4.6 4.7Z",
    "M24.6 4.3l-2.2 4 4.6 4.7Z",
  ], // nubs
  [
    "M10.8 4.9h1.3v8.1h-1.3Z",
    "M9.8 3.7a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0Z",
    "M19.9 4.9h1.3v8.1h-1.3Z",
    "M18.8 3.7a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0Z",
  ], // twin
];

/**
 * One eye, as a rounded box about its centre. A circle is the case where both radii and the corner
 * agree, which is what lets every variant share one element and one closing animation.
 */
export interface Eye {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  round: number;
}

/** The line every eye sits on, a little above centre, where a face reads as awake. */
const EYE_Y = 17;

/** The eye SHAPES. Where they land is the head's business, through its span. */
const EYE_SHAPES: readonly { rx: number; ry: number; round: number; single?: boolean }[] = [
{ rx: 3, ry: 3, round: 3 }, // round
  { rx: 2.8, ry: 2.8, round: 1 }, // square
  { rx: 1.9, ry: 3.7, round: 1.9 }, // slit
  { rx: 3.2, ry: 2.1, round: 2.1 }, // band
  { rx: 4.6, ry: 4.6, round: 4.6, single: true }, // cyclops
];

/**
 * How many faces the set holds: every head, under every top, under every eye shape.
 *
 * Five hundred, and the number is load-bearing. The permutation below is exact over
 * every input under it, so two ranks never reach the same face. Bots number from zero and sessions
 * from `BOT_SESSION_FACE_BASE`, so the two never share an input while Bots number under 40. Past
 * either bound the faces still draw; they just stop promising uniqueness.
 */
export const BOT_FACE_PAIRS = 500;

/**
 * Scatters neighbouring ranks across the set.
 *
 * Consecutive ranks MUST NOT draw neighbouring faces: a new arrival would otherwise wear something
 * near-identical to the Bot before it. 37 is coprime to 500, so it permutes the set exactly,
 * throwing consecutive inputs across heads, tops and eyes alike.
 */
const FACE_PERMUTE = 37;

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
 * A rank that is not finite draws rank zero rather than nothing, because the only thing a caller
 * can do with a thrown error here is draw no face at all.
 */
export function botFaceOf(rank: number): BotFaceShape {
  const floored = Math.floor(rank);
  const at = Number.isFinite(floored) ? Math.abs(floored) : 0;
  const pair = ((at % BOT_FACE_PAIRS) * FACE_PERMUTE) % BOT_FACE_PAIRS;
  const head = HEADS[pair % HEADS.length]!;
  const shape = EYE_SHAPES[Math.floor(pair / (HEADS.length * TOPS.length)) % EYE_SHAPES.length]!;
  const eye = (cx: number): Eye => ({ cx, cy: EYE_Y, rx: shape.rx, ry: shape.ry, round: shape.round });
  return {
    head: head.d,
    top: TOPS[Math.floor(pair / HEADS.length) % TOPS.length]!,
    eyes: shape.single
      ? [eye(16)]
      : [eye(Number((16 - head.span).toFixed(2))), eye(Number((16 + head.span).toFixed(2)))],
  };
}

/**
 * A Bot's face, sized by its caller.
 *
 * It fills nothing on its own: the avatar is already sized in one place (`size-8` for a session,
 * `size-11` and `size-12` for a Bot) and a number here is a second place for those to disagree. It
 * stands alone rather than inside the initials' disc, whose circle would ring every head in the
 * shape the faces were drawn to replace.
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
export function BotFace({ rank, shut = false, className = "", style }: {
  rank: number;
  /** Eyes closed. The caller decides what that means; nothing here knows about the canvas. */
  shut?: boolean;
  className?: string;
  /** The hue the face's CSS reads for the head and the eye sockets. */
  style?: CSSProperties;
}) {
  const face = botFaceOf(rank);
  return (
    <svg
      viewBox="0 0 32 32"
      className={`bot-face ${className}`}
      style={style}
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
