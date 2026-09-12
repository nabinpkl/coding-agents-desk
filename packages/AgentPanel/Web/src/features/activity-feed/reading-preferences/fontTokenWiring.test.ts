import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FONT_TOKENS } from "@/features/activity-feed/reading-preferences/fontStore";

/**
 * The font settings modal is only as real as its wiring, and both ways it can
 * come apart are invisible from the modal itself.
 *
 * A token with no consumer renders a control that moves nothing: five of the
 * twelve were in that state -- the entire Sidebar tab -- because the sidebar
 * was written with hardcoded Tailwind sizes and nobody noticed the slider had
 * stopped reaching anything.
 *
 * A consumer whose literal fallback disagrees with `defaultPx` is worse,
 * because it only shows for the one frame before `FontSizeRoot` sets the
 * variables. Those literals exist for exactly that frame, which makes them a
 * second copy of every default with no pressure to stay honest.
 */

const SRC = resolve("src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (!/\.(ts|tsx|css)$/.test(extname(path) ? path : "")) continue;
    // The store defines the tokens; a test asserting on them is not a consumer.
    if (path.endsWith("fontStore.ts") || path.includes(".test.")) continue;
    out.push(path);
  }
  return out;
}

/** Every `--agent-panel-fs-*` reference in the app, with the fallback it names. */
const references = sourceFiles(SRC).flatMap((path) => {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/--agent-panel-fs-[a-z-]+\s*,\s*(\d+)px/g)].map((m) => ({
    path,
    cssVar: m[0].slice(0, m[0].indexOf(",")).trim(),
    fallbackPx: Number(m[1]),
  }));
});

describe("Agent Panel font token wiring", () => {
  it("gives every token at least one consumer", () => {
    const orphans = FONT_TOKENS.filter(
      (token) => !references.some((r) => r.cssVar === token.cssVar),
    ).map((token) => token.key);
    // No exemptions. A token that nothing reads is a control that moves
    // nothing, and the only honest fixes are to wire it or to delete it.
    expect(orphans).toEqual([]);
  });

  it("keeps every consumer's fallback equal to the token's default", () => {
    const mismatches = references
      .map((r) => {
        const token = FONT_TOKENS.find((t) => t.cssVar === r.cssVar);
        if (!token) return `${r.cssVar} in ${r.path} names no token`;
        if (token.defaultPx !== r.fallbackPx) {
          return `${r.cssVar} falls back to ${r.fallbackPx}px but defaults to ${token.defaultPx}px`;
        }
        return null;
      })
      .filter(Boolean);
    expect(mismatches).toEqual([]);
  });
});
