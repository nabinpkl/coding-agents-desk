import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * On iOS the panel is an app surface inside a native shell, not a page, so its scale is pinned.
 *
 * The argument for pinning is in `index.html`, and it rests on something in another file: the
 * document is locked to the viewport by `styles.css`, so it can neither scroll nor spill sideways
 * under its own power. That makes any horizontal pan, and any "it came up too big", a scale other
 * than 1 -- which pinning removes. Both halves are asserted here because either one alone is not
 * the invariant: unpin the meta and pinch comes back, unlock the document and the meta is pinning
 * a page that can now genuinely overflow.
 */
// From the package root rather than `import.meta.url`, which Vite rewrites to a non-file URL.
const html = readFileSync(resolve(process.cwd(), "index.html"), "utf8");
const css = readFileSync(resolve(process.cwd(), "src/app/styles.css"), "utf8");

// Whitespace-collapsed first, because the tag is long enough to be wrapped across lines and a
// pattern that only matches the one-line spelling would go quiet the moment someone reformats it.
const viewport = /<meta name="viewport" content="([^"]+)"/.exec(html.replace(/\s+/g, " "))?.[1];

describe("viewport scale", () => {
  it("lays out at the device's width", () => {
    expect(viewport).toBeDefined();
    expect(viewport).toContain("width=device-width");
    expect(viewport).toContain("initial-scale=1");
  });

  it("pins the scale in both spellings", () => {
    // `user-scalable=no` and the min/max pair are not honoured by the same engines, so neither
    // alone closes it everywhere the panel runs.
    expect(viewport).toContain("user-scalable=no");
    expect(viewport).toContain("minimum-scale=1");
    expect(viewport).toContain("maximum-scale=1");
  });

  it("keeps the document itself unscrollable, which is what the pin assumes", () => {
    // The app's own overflow containers do every scroll; the document does none. Without this,
    // a pinned scale would leave real content unreachable instead of leaving nothing to reach.
    const collapsed = css.replace(/\s+/g, " ");
    expect(collapsed).toContain("html, body, #root { height: 100%; }");
    expect(collapsed).toContain("overflow: hidden;");
  });
});
