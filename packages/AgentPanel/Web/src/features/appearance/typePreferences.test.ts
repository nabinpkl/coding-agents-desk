import { beforeEach, describe, expect, it } from "vitest";
import {
  applyTypePreference,
  DEFAULT_TYPE,
  familyFor,
  ladderFor,
  loadTypePreference,
  storeTypePreference,
  TYPE_FAMILIES,
  TYPE_WEIGHTS,
} from "@/features/appearance/typePreferences";

/**
 * Every failure here is SILENT on the page. A stored value that no longer names anything, a
 * ladder that lands two steps on one number, a property written under the wrong name: none of
 * them throws, and each one leaves a panel that renders and quietly stops looking the way the
 * reader set it.
 */
describe("panel type preference", () => {
  beforeEach(() => localStorage.clear());

  it("comes back to the default rather than trusting what it finds", () => {
    // Each of these has actually happened to one of the other stores in this panel: a shape from
    // an older version, a field hand-edited in devtools, a value left behind by a family that was
    // retired. An unvalidated read turns the last one into a `--font-sans` naming nothing, and
    // the whole panel renders in the UA's serif with no error anywhere.
    for (const raw of [
      "not json",
      "null",
      '"a string"',
      "[]",
      '{"family":"comic","weight":400}',
      '{"family":"inter","weight":9000}',
      '{"weight":450}',
    ]) {
      localStorage.setItem("agent-panel.type", raw);
      const loaded = loadTypePreference();
      expect(
        TYPE_FAMILIES.some((family) => family.id === loaded.family),
        raw,
      ).toBe(true);
      expect(TYPE_WEIGHTS.includes(loaded.weight), raw).toBe(true);
    }
  });

  it("keeps the good half of a half-bad record", () => {
    // Field by field rather than all or nothing: a reader who picked Geist at 500 and then lost
    // the weight to a shape change should not also lose the family.
    localStorage.setItem("agent-panel.type", '{"family":"geist","weight":123}');
    expect(loadTypePreference()).toEqual({ family: "geist", weight: DEFAULT_TYPE.weight });
  });

  it("survives a round trip", () => {
    storeTypePreference({ family: "schibsted", weight: 500 });
    expect(loadTypePreference()).toEqual({ family: "schibsted", weight: 500 });
  });

  it("opens on a family that is really there", () => {
    expect(TYPE_FAMILIES.some((family) => family.id === DEFAULT_TYPE.family)).toBe(true);
    expect(TYPE_WEIGHTS).toContain(DEFAULT_TYPE.weight);
  });

  it("spaces the ladder so no two utilities land on one number", () => {
    // The property, not the numbers. Two steps sharing a weight erases the emphasis they encode
    // across 144 call sites, and nothing reports it.
    for (const base of TYPE_WEIGHTS) {
      for (const family of TYPE_FAMILIES) {
        const steps = Object.values(ladderFor(base, family));
        expect(new Set(steps).size, `${family.id} @ ${base}`).toBe(steps.length);
        expect(
          [...steps].sort((a, b) => a - b),
          `${family.id} @ ${base}`,
        ).toEqual(steps);
      }
    }
  });

  it("keeps every step inside the axis the family actually draws", () => {
    // Schibsted Grotesk starts at 400. A ladder reaching below it would be synthesized rather
    // than drawn, which looks like a font that loaded wrong rather than a weight that was asked
    // for. The clamp is why the picker can offer one range for all four families.
    for (const family of TYPE_FAMILIES) {
      for (const base of TYPE_WEIGHTS) {
        for (const weight of Object.values(ladderFor(base, family))) {
          expect(weight, family.id).toBeGreaterThanOrEqual(family.minWeight);
          expect(weight, family.id).toBeLessThanOrEqual(900);
        }
      }
    }
  });

  it("writes the properties the stylesheet reads, under the names it reads them by", () => {
    // The names are the contract with `app/styles.css`, and a typo in either place is invalid at
    // computed value time: the utility emits nothing and the weight falls back to whatever was
    // inherited. `typeRendering.test.ts` pins the other end of the same contract.
    const root = document.createElement("div");
    applyTypePreference(root, { family: "geist", weight: 500 });
    expect(root.style.getPropertyValue("--font-sans")).toBe(familyFor("geist").stack);
    expect(root.style.getPropertyValue("--font-weight-normal")).toBe("500");
    expect(root.style.getPropertyValue("--font-weight-medium")).toBe("600");
    expect(root.style.getPropertyValue("--font-weight-semibold")).toBe("700");
    expect(root.style.getPropertyValue("--font-weight-bold")).toBe("800");
  });

  it("falls back to a real family rather than returning nothing for an unknown id", () => {
    expect(familyFor("gone")).toBe(TYPE_FAMILIES[0]);
  });
});
