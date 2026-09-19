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
// So every face is GENERATED, not picked: a seeded stream draws one head outline and one set of
// eyes per rank, with no catalogue and no cycle. A catalogue is what this was, and forty entries
// cannot cover eighteen Bots and thirty-two sessions without dressing two of them alike -- the
// failure a face exists to prevent. The space below holds 65,536 drawings; the permutation scatters
// neighbouring ranks across it, so a new arrival never resembles its neighbour.
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
 * How many drawings the generator holds.
 *
 * 2^16, and the number is load-bearing for the promise below. The rank-to-index permutation is
 * exact over every input under it, so two ranks never even REACH the same drawing slot -- what is
 * left is whether one slot's drawing equals another's, and the test pins the realistic range
 * exactly rather than hoping. Real rosters are tens of faces; this bound is hundreds of times
 * past that. Bots number from zero and sessions from `BOT_SESSION_FACE_BASE`, so the two never
 * share an input while Bots number under 2048.
 */
export const BOT_FACE_SPACE = 65536;

/**
 * Scatters neighbouring ranks across the face space.
 *
 * Consecutive ranks MUST NOT draw neighbouring faces: a new Bot arriving after another would
 * otherwise wear something near-identical to it. Any odd multiplier permutes 2^16 exactly, and
 * this one throws consecutive inputs the width of the space apart.
 */
const FACE_PERMUTE = 32189;

/** SplitMix32: one strong hash from an index, identical on every load. No Math.random anywhere. */
function hashSeed(index: number): number {
  let z = (index + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

/** Mulberry32 stream from a hashed seed: the face's private dice, in a fixed order. */
function stream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two decimals: exact enough to draw from, coarse enough that a path serialises stably. */
const r2 = (n: number): number => Math.round(n * 100) / 100;
const f = (point: readonly [number, number]): string => `${r2(point[0])} ${r2(point[1])}`;

const HEAD_CX = 16;
const HEAD_CY = 16.5;
const HEAD_R = 8.8;

/**
 * One head outline in the 32x32 box, drawn from the stream.
 *
 * Six to nine spokes about the centre, each with its own radius: an independent jitter plus a
 * harmonic swell, so some heads read faceted and some lumpy. One cheek is drawn broader than the
 * other, the jaw differs from the crown, and the whole thing leans a little -- asymmetry is a
 * dimension like any other, and a generator that only draws mirror-symmetric heads has half the
 * space. Near-half the heads join their spokes with straight edges and rounded corners, the rest
 * with one smooth closed curve; `fitBox` below shrinks the rare joint maximum back inside the box.
 */
function headPath(next: () => number): string {
  const smooth = next() < 0.45;
  const spokes = 6 + Math.floor(next() * 4);
  const variation = next() * 0.42;
  const harmonics = 1 + Math.floor(next() * 3);
  const phase = next() * Math.PI * 2;
  const broad = 0.93 + next() * 0.14;
  const corner = next() * 0.55;
  const aspectX = 0.9 + next() * 0.18;
  const aspectY = 0.92 + next() * 0.16;
  const taper = (next() - 0.5) * 0.3;
  const tilt = (next() - 0.5) * 0.2;
  const base = next() * Math.PI * 2;
  const cosTilt = Math.cos(tilt);
  const sinTilt = Math.sin(tilt);
  const pts: Array<readonly [number, number]> = [];
  for (let k = 0; k < spokes; k += 1) {
    const angle = base + (k / spokes) * Math.PI * 2;
    const radius = HEAD_R
      * (1 + (next() - 0.5) * variation + (variation / 2) * Math.cos(harmonics * angle + phase));
    let x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    // One cheek broader than the other, mirrored so the width survives the difference.
    x *= x < 0 ? broad : 2 - broad;
    const wide = x * aspectX;
    const tall = y * aspectY;
    // The jaw differs from the crown.
    const tapered = wide * (1 + taper * (tall / HEAD_R));
    pts.push([
      HEAD_CX + tapered * cosTilt - tall * sinTilt,
      HEAD_CY + tapered * sinTilt + tall * cosTilt,
    ]);
  }
  if (smooth) return smoothClosed(fitBox(pts));
  return roundedPolygon(fitBox(pts), corner);
}

/**
 * Shrinks the spokes about the centre until the head fits the box it is drawn in.
 *
 * The radius swing, asymmetry, aspect, taper and tilt multiply, and their joint maximum reaches
 * past the viewport -- an SVG clips that silently, which reads as a head with its edge sliced
 * off. Scaling about the centre instead keeps every head whole: shape is what names the Bot, and
 * a smaller whole head still says it where a clipped one says nothing.
 */
function fitBox(pts: Array<readonly [number, number]>): Array<readonly [number, number]> {
  // The head must stay inside 2..30 on both axes: what hangs past the viewport is clipped
  // silently, which reads as a head with its edge sliced off.
  const limitX = 30 - 2;
  const limitY = Math.min(HEAD_CY - 2, 30 - HEAD_CY) * 2;
  let scale = 1;
  for (const [x, y] of pts) {
    scale = Math.min(
      scale,
      limitX / 2 / Math.max(0.01, Math.abs(x - HEAD_CX)),
      limitY / 2 / Math.max(0.01, Math.abs(y - HEAD_CY)),
    );
  }
  if (scale >= 1) return pts;
  return pts.map(([x, y]) => [
    HEAD_CX + (x - HEAD_CX) * scale,
    HEAD_CY + (y - HEAD_CY) * scale,
  ] as const);
}

/** The spokes joined by straight edges with rounded corners. Corner 0 draws sharp. */
function roundedPolygon(pts: Array<readonly [number, number]>, corner: number): string {
  const n = pts.length;
  let d = "";
  for (let i = 0; i < n; i += 1) {
    const prev = pts[(i - 1 + n) % n]!;
    const curr = pts[i]!;
    const nextPt = pts[(i + 1) % n]!;
    const inLen = Math.hypot(curr[0] - prev[0], curr[1] - prev[1]) || 1;
    const outLen = Math.hypot(nextPt[0] - curr[0], nextPt[1] - curr[1]) || 1;
    const c = (corner * Math.min(inLen, outLen)) / 2;
    const a: readonly [number, number] = [
      curr[0] - ((curr[0] - prev[0]) / inLen) * c,
      curr[1] - ((curr[1] - prev[1]) / inLen) * c,
    ];
    const b: readonly [number, number] = [
      curr[0] + ((nextPt[0] - curr[0]) / outLen) * c,
      curr[1] + ((nextPt[1] - curr[1]) / outLen) * c,
    ];
    d += `${i === 0 ? "M" : "L"}${f(a)}Q${f(curr)} ${f(b)}`;
  }
  return `${d}Z`;
}

/** The spokes joined by one smooth closed curve through all of them. */
function smoothClosed(pts: Array<readonly [number, number]>): string {
  const n = pts.length;
  let d = `M${f(pts[0]!)}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    const c1: readonly [number, number] = [
      p1[0] + (p2[0] - p0[0]) / 6,
      p1[1] + (p2[1] - p0[1]) / 6,
    ];
    const c2: readonly [number, number] = [
      p2[0] - (p3[0] - p1[0]) / 6,
      p2[1] - (p3[1] - p1[1]) / 6,
    ];
    d += `C${f(c1)} ${f(c2)} ${f(p2)}`;
  }
  return `${d}Z`;
}

/**
 * One eye, as a rounded box about its centre. A circle is the case where both radii and the corner
 * agree, which is what lets every generated variant share one element and one closing animation.
 */
interface Eye {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  round: number;
}

/**
 * The eyes for one face, drawn from the same stream after the head.
 *
 * Shape AND number: one eye is the strongest silhouette here, so about one face in eight is a
 * cyclops. Size, height and spacing move within bands measured to stay on every head the
 * generator draws: the narrowest head is eleven across at the eyes' height, and the widest pair
 * of eyes spans under six.
 */
function eyesOf(next: () => number): readonly Eye[] {
  const single = next() < 0.13;
  const shape = next();
  const size = 2.3 + next() * 1.6;
  const cy = r2(15.8 + next() * 3.4);
  const dims = shape < 0.32
    ? { rx: size, ry: size, round: size }
    : shape < 0.52
      ? { rx: size * 0.95, ry: size * 0.95, round: 1 }
      : shape < 0.74
        ? { rx: size * 1.35, ry: size * 0.72, round: size * 0.72 }
        : { rx: size * 0.68, ry: size * 1.35, round: size * 0.68 };
  if (single) {
    const big = size * 1.5;
    return [{ cx: 16, cy, rx: big, ry: big, round: big }];
  }
  const gap = 4.0 + next() * 1.8;
  const left = r2(16 - gap / 2);
  const right = r2(16 + gap / 2);
  return [
    { cx: left, cy, ...dims },
    { cx: right, cy, ...dims },
  ];
}

/** Which parts a rank draws: one generated outline and one generated set of eyes. */
export interface BotFaceShape {
  head: string;
  eyes: readonly Eye[];
}

/**
 * The face at a given rank.
 *
 * The rank is the Bot's place in the roster ordered by creation, which is what `botCanvasHues`
 * ranks on and for the same three reasons it gives: taking a Bot off the canvas re-faces nothing,
 * a new Bot re-faces nothing, and a Bot keeps its face for as long as it exists. Sessions number
 * from `BOT_SESSION_FACE_BASE`, so the two never share an input while Bots number under 2048.
 *
 * The rank is permuted into the face space and hashed: the same rank draws the same face on every
 * load, and neighbouring ranks land nowhere near each other. A rank that is not finite draws rank
 * zero rather than nothing, because the only thing a caller can do with a thrown error here is
 * draw no face at all.
 */
export function botFaceOf(rank: number): BotFaceShape {
  const floored = Math.floor(rank);
  const at = Number.isFinite(floored) ? Math.abs(floored) : 0;
  const rand = stream(hashSeed(((at % BOT_FACE_SPACE) * FACE_PERMUTE) % BOT_FACE_SPACE));
  return {
    head: headPath(rand),
    eyes: eyesOf(rand),
  };
}

/**
 * A Bot's face, sized by its caller.
 *
 * It fills nothing on its own: the avatar is already sized in one place (`size-6` for a session,
 * `size-9` and `size-10` for a Bot) and a number here is a second place for those to disagree. It
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
