import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appStyles = readFileSync(resolve("src/app/styles.css"), "utf8");

/**
 * Every failure this pins is SILENT at runtime: the browser drops an
 * unresolvable `@font-face` or an invalid custom property without an error and
 * falls back down the family list -- or, when the list itself is invalid, to
 * the UA default, which is a serif. So the panel keeps rendering and just
 * quietly stops being the typeface it was meant to be.
 */
describe("Agent Panel font stack", () => {
  it("gives --font-sans a concrete value rather than leaving the theme token dangling", () => {
    // `@theme inline` republishes `--font-sans: var(--font-sans)` as Tailwind's
    // `font-sans` utility. That is a self-reference until :root defines the
    // real stack; drop the :root line and the property is invalid at computed
    // value time, taking `body`'s font-family down with it.
    expect(appStyles).toMatch(
      /^\s*--font-sans:\s*"Inter Variable",\s*system-ui,\s*-apple-system,\s*sans-serif;/m,
    );
    expect(appStyles).toContain("font-family: var(--font-sans);");
  });

  it("keeps optical sizing on, which is what the opsz build is bundled for", () => {
    expect(appStyles).toContain("font-optical-sizing: auto;");
  });

  it("points every @font-face at a file the installed package actually ships", () => {
    const sources = [...appStyles.matchAll(/src:\s*url\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(sources).toHaveLength(4);
    for (const specifier of sources) {
      expect(existsSync(resolve("node_modules", specifier))).toBe(true);
    }
  });

  it("declares both styles, so the italic reasoning rows get a real italic", () => {
    // Without an italic face the browser synthesizes an oblique by shearing the
    // upright, which is thinner and worse-spaced -- and reasoning rows, the
    // feed's only italic surface, are already its lightest text.
    const styles = [...appStyles.matchAll(/font-style:\s*(normal|italic);/g)].map((m) => m[1]);
    expect(styles.filter((s) => s === "normal")).toHaveLength(2);
    expect(styles.filter((s) => s === "italic")).toHaveLength(2);
  });
});
