import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `index.html` carries an inline copy of the panel background so the first paint is not white.
 * It has to be a copy: `styles.css` is imported from `main.tsx`, so the real token does not exist
 * until the module graph has loaded, which on the phone means a tailnet round trip.
 *
 * A copy that drifts is worse than no copy -- the flash comes back in one theme only, and looks
 * like a rendering bug rather than a stale literal -- so the two are compared here.
 */
// From the package root rather than `import.meta.url`, which Vite rewrites to a non-file URL.
const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const css = readFileSync(resolve(process.cwd(), "src/app/styles.css"), "utf8");

function matches(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[1]!.trim());
}

describe("critical background", () => {
  it("declares light then dark, once each", () => {
    expect(matches(html, /^\s*background:\s*([^;]+);/gm)).toHaveLength(2);
    expect(matches(css, /--background:\s*([^;]+);/g)).toHaveLength(2);
  });

  it("matches the --background token in both themes", () => {
    expect(matches(html, /^\s*background:\s*([^;]+);/gm)).toEqual(
      matches(css, /--background:\s*([^;]+);/g),
    );
  });

  it("keeps the inline style ahead of the module script", () => {
    // Ahead in the document, and inline rather than linked: a stylesheet the browser has to
    // fetch reintroduces exactly the gap this closes.
    expect(html.indexOf("<style>")).toBeGreaterThan(-1);
    expect(html.indexOf("<style>")).toBeLessThan(html.indexOf("<script"));
    expect(html).toContain("color-scheme: light dark");
    // In a layer declared before Tailwind's, so the real stylesheet wins once it arrives.
    expect(html).toContain("@layer critical");
  });
});
