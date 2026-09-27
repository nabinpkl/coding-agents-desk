// Which face the panel is set in, and how heavy, as the reader's own choice.
//
// This exists because the question has no right answer from here. A face that reads well on a
// bright laptop reads thin on a dark 8K desk, and the same paragraph judged at prose size says
// nothing about the 10px chips beside it. Three attempts to settle it by taste went a different
// way each time, so it stopped being a decision in CSS and became a control.
//
// Everything is applied by writing custom properties on the document element, which is why no
// component below `body` has to know a choice was made: `--font-sans` is the stack Tailwind's
// `font-sans` utility resolves to, and the four `--font-weight-*` are what its weight utilities
// resolve to. Both are declared in `app/styles.css`; this only overrides them.

/** A face the reader can pick. `stack` is the whole `--font-sans` value, fallbacks included. */
export interface TypeFamily {
  id: string;
  label: string;
  stack: string;
  /**
   * The lowest weight this family's axis actually carries.
   *
   * Schibsted Grotesk starts at 400 rather than 100, so a ladder that reached below it would be
   * synthesized instead of drawn. Nothing in the panel asks below 400 today, so this is a floor
   * the picker respects rather than a range it offers.
   */
  minWeight: number;
}

const SYSTEM_FALLBACK = "system-ui, -apple-system, sans-serif";

export const TYPE_FAMILIES: readonly TypeFamily[] = [
  // Inter first because it is what the panel opens with, and the only one of these with an
  // optical-size axis -- `font-optical-sizing: auto` on `body` is what spends it.
  { id: "inter", label: "Inter", stack: `"Inter Variable", ${SYSTEM_FALLBACK}`, minWeight: 100 },
  {
    id: "schibsted",
    label: "Schibsted",
    stack: `"Schibsted Grotesk Variable", ${SYSTEM_FALLBACK}`,
    minWeight: 400,
  },
  { id: "geist", label: "Geist", stack: `"Geist Variable", ${SYSTEM_FALLBACK}`, minWeight: 100 },
  { id: "roboto", label: "Roboto", stack: `"Roboto Variable", ${SYSTEM_FALLBACK}`, minWeight: 100 },
  // No webfont at all, which is the one option that cannot fail to load and the fastest first
  // paint. On this Mac that is SF, on the phone it is SF, and on anything else it is whatever the
  // OS considers its UI face.
  { id: "system", label: "System", stack: SYSTEM_FALLBACK, minWeight: 100 },
];

/**
 * The base weights on offer, which are the weights of ordinary body text.
 *
 * The rest of the ladder is derived rather than listed, at +100 a step, because that spacing is
 * what separates `font-medium` from `font-semibold`. Picking a base and letting the steps follow
 * is the only shape that cannot land two utilities on the same number, which would silently erase
 * the emphasis they encode across 144 call sites.
 */
export const TYPE_WEIGHTS: readonly number[] = [400, 450, 500, 550];

export const DEFAULT_TYPE: TypePreference = { family: "inter", weight: 400 };

export interface TypePreference {
  family: string;
  weight: number;
}

const STORAGE_KEY = "agent-panel.type";

export function familyFor(id: string): TypeFamily {
  return TYPE_FAMILIES.find((family) => family.id === id) ?? TYPE_FAMILIES[0];
}

/**
 * The four weights a base implies, clamped to what the family can draw.
 *
 * `bold` is the step that runs out of room first: base 550 wants 850, which every family here
 * carries, but a family added later with a narrower axis would not. Clamping at both ends keeps a
 * new family from quietly turning the top of the ladder into a synthesized bold.
 */
export function ladderFor(base: number, family: TypeFamily): Record<string, number> {
  const clamp = (weight: number) => Math.min(900, Math.max(family.minWeight, weight));
  return {
    "--font-weight-normal": clamp(base),
    "--font-weight-medium": clamp(base + 100),
    "--font-weight-semibold": clamp(base + 200),
    "--font-weight-bold": clamp(base + 300),
  };
}

/**
 * Reads the stored choice, falling back to the default rather than trusting what it finds.
 *
 * Validated field by field: a family id that no longer exists (a face retired, a hand-edited
 * value) would otherwise become a `--font-sans` naming nothing, and the whole panel would render
 * in the UA's serif with no error anywhere. A private window and a container with storage
 * disabled both throw on the read itself.
 */
export function loadTypePreference(): TypePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_TYPE;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_TYPE;
    const record = parsed as Record<string, unknown>;
    const family = TYPE_FAMILIES.some((known) => known.id === record.family)
      ? (record.family as string)
      : DEFAULT_TYPE.family;
    const weight = TYPE_WEIGHTS.includes(record.weight as number)
      ? (record.weight as number)
      : DEFAULT_TYPE.weight;
    return { family, weight };
  } catch {
    return DEFAULT_TYPE;
  }
}

export function storeTypePreference(preference: TypePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // A reader whose storage is unavailable still gets the choice they just made; they only lose
    // it on reload, which is better than the control refusing to work.
  }
}

/**
 * Puts a choice on the document.
 *
 * Takes the element rather than reaching for `document`, so the test can assert against a node it
 * owns and so this stays callable from the one effect that writes it.
 */
export function applyTypePreference(root: HTMLElement, preference: TypePreference): void {
  const family = familyFor(preference.family);
  root.style.setProperty("--font-sans", family.stack);
  for (const [name, weight] of Object.entries(ladderFor(preference.weight, family))) {
    root.style.setProperty(name, String(weight));
  }
}
