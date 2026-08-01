import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appStyles = readFileSync(resolve("src/app/styles.css"), "utf8");
const markdownStyles = readFileSync(
  resolve("src/features/activity-feed/markdown/markdown.css"),
  "utf8",
);
const eventRows = readFileSync(
  resolve("src/features/activity-feed/ActivityEventRows.tsx"),
  "utf8",
);

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
    const consumers = eventRows.match(/leading-\(--agent-panel-prose-leading\)/g) ?? [];
    expect(consumers).toHaveLength(3);
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
