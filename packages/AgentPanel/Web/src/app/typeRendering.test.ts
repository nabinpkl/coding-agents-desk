import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TYPE_FAMILIES } from "@/features/appearance/typePreferences";

const appStyles = readFileSync(resolve("src/app/styles.css"), "utf8");
const markdownStyles = readFileSync(
  resolve("src/features/activity-feed/markdown/markdown.css"),
  "utf8",
);
// Both files: the text wrappers moved into `ActivityBlockViews.tsx` when the rows were
// split, and the rule is about all of them wherever they live.
const eventRows = [
  "src/features/activity-feed/blocks/ActivityEventRows.tsx",
  "src/features/activity-feed/blocks/ActivityBlockViews.tsx",
].map((path) => readFileSync(resolve(path), "utf8")).join("\n");

/**
 * Every failure this pins is SILENT at runtime. The browser drops an
 * unresolvable `@font-face`, an invalid custom property, or a line-height
 * naming a variable nobody defined, all without an error: it just falls back
 * -- down the family list, or to the UA default, which is a serif, or to
 * whatever leading happens to be inherited. So the panel keeps rendering and
 * quietly stops looking the way it was meant to.
 */
describe("Agent Panel type rendering", () => {
  it("keeps one prose leading, read by the markdown renderer and every text wrapper", () => {
    // Assistant prose renders through Markdown; user messages and tool text
    // take the plain path beside it. They had drifted to 1.45 and 1.375, so the
    // same paragraph read differently depending on who wrote it.
    expect(appStyles).toMatch(/--agent-panel-prose-leading:\s*[\d.]+;/);
    expect(markdownStyles).toContain("line-height: var(--agent-panel-prose-leading");
    // Tailwind emits nothing for a malformed arbitrary-property class, and the
    // line-height then silently falls back to whatever is inherited.
    //
    // A census, not a cap: the number moves when a wrapper is added, and it is here so that a
    // wrapper added WITHOUT the token has to be noticed. Four today -- assistant prose, the plain
    // path beside it, a reasoning trace, and the body of a skill folded into the call that
    // loaded it.
    const consumers = eventRows.match(/leading-\(--agent-panel-prose-leading\)/g) ?? [];
    expect(consumers).toHaveLength(4);
    expect(eventRows).not.toContain("leading-snug text-foreground");
  });

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

  it("keeps font smoothing explicit, since it has been set both ways", () => {
    // `-webkit-font-smoothing` thins every stroke, so it is a real decision rather
    // than a default worth inheriting, and it has been switched twice: off under
    // Roboto, which needed the stroke back, and on under this face, which does not.
    // Neither state errors and neither shows in a diff of the rendered markup, so
    // the file pins whichever one is current and the reason sits beside the rule.
    expect(appStyles).toMatch(/^\s*-webkit-font-smoothing: antialiased;/m);
  });

  it("keeps the tracking that answers Roboto setting tighter than Inter did", () => {
    // Paired with the line above: the two together are what replaced a weight
    // bump, so losing either one puts the panel back where it started.
    expect(appStyles).toMatch(/^\s*letter-spacing: 0\.\d+em;/m);
  });

  it("points every @font-face at a file the installed package actually ships", () => {
    const sources = [...appStyles.matchAll(/src:\s*url\("([^"]+)"\)/g)].map((m) => m[1]!);
    // Four families, each latin and latin-ext, each upright and italic. A census rather than a
    // cap: it moves when the picker gains or loses a family, and it is here so that removing a
    // package without removing its faces has to be noticed.
    expect(sources).toHaveLength(16);
    for (const specifier of sources) {
      expect(existsSync(resolve("node_modules", specifier))).toBe(true);
    }
  });

  it("declares a face for every family the picker offers", () => {
    // The failure this pins is the whole reason the picker is risky: choosing a family whose
    // `@font-face` was never written sets `--font-sans` to a name nothing resolves, and the panel
    // falls through to the UA default -- a serif -- with no error anywhere.
    for (const family of TYPE_FAMILIES) {
      const quoted = /^"([^"]+)"/.exec(family.stack)?.[1];
      // System is the one family with no webfont by design: its stack is the fallbacks alone.
      if (!quoted) {
        expect(family.id).toBe("system");
        continue;
      }
      expect(appStyles, family.id).toContain(`font-family: "${quoted}";`);
    }
  });

  it("declares both styles, so the italic reasoning rows get a real italic", () => {
    // Without an italic face the browser synthesizes an oblique by shearing the
    // upright, which is thinner and worse-spaced -- and reasoning rows, the
    // feed's only italic surface, are already its lightest text.
    const styles = [...appStyles.matchAll(/font-style:\s*(normal|italic);/g)].map((m) => m[1]);
    const webfonts = TYPE_FAMILIES.filter((family) => family.stack.startsWith('"')).length;
    expect(styles.filter((s) => s === "normal")).toHaveLength(webfonts * 2);
    expect(styles.filter((s) => s === "italic")).toHaveLength(webfonts * 2);
  });
});
