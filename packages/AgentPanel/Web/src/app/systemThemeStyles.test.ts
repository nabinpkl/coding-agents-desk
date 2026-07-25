import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appStyles = readFileSync(resolve("src/app/styles.css"), "utf8");
const markdownStyles = readFileSync(
  resolve("src/features/activity-feed/markdown/markdown.css"),
  "utf8",
);

describe("Agent Panel system theme styles", () => {
  it("uses the system color-scheme for tokens, Tailwind variants, and Shiki", () => {
    expect(appStyles).toContain("color-scheme: light dark");
    expect(appStyles).toContain("@media (prefers-color-scheme: dark)");
    expect(appStyles).not.toMatch(/^\.dark\s*\{/m);
    expect(markdownStyles).toContain("@media (prefers-color-scheme: dark)");
    expect(markdownStyles).not.toContain(".dark .agent-panel-code");
  });
});
