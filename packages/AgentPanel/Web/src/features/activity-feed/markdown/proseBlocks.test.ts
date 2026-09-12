import { describe, it, expect } from "vitest";
import {
  createStreamingBlocks,
  FENCE_SLOT_ATTRIBUTE,
  toBlocks,
} from "@/features/activity-feed/markdown/proseBlocks";

// The whole point of the incremental reader is that it is not a different renderer.
// So the test is not "does it produce something reasonable" but "is it the same
// answer as the whole-document path, at every intermediate state a reveal passes
// through" -- because a wrong answer would be visible for one tick and then gone,
// which is the failure mode a snapshot of the finished message cannot catch.

/** The reveal's own pacing, from `streamingText.ts`. */
function revealSteps(text: string): string[] {
  const out: string[] = [];
  let shown = 0;
  while (shown < text.length) {
    shown = Math.min(text.length, shown + Math.max(3, Math.ceil((text.length - shown) / 24)));
    out.push(text.slice(0, shown));
  }
  return out;
}

function expectMatchesWholeDocumentAtEveryTick(text: string): void {
  const blocks = createStreamingBlocks();
  for (const prefix of revealSteps(text)) {
    expect(blocks(prefix), `at ${prefix.length} of ${text.length} chars`).toEqual(toBlocks(prefix));
  }
}

const LONG_PROSE = Array.from(
  { length: 40 },
  (_, index) =>
    `## Section ${index}\n\nSome **bold** prose with \`code\` and a [link](http://example.test) ` +
    `that runs long enough to push earlier sections out of the live window.\n\n` +
    `- item one\n- item two\n`,
).join("\n");

describe("createStreamingBlocks", () => {
  // ~170 ticks, each rendering the document twice through marked and DOMPurify. Roughly
  // 0.9s on an idle machine, and it timed out at vitest's 5s default once while sharing
  // the box with 35 other test files. The exhaustiveness is the point, so it gets room
  // rather than fewer ticks -- shrinking the document does not help, because the reveal's
  // step count grows with the log of its length, not its length.
  it("matches the whole-document reader at every tick of a long reveal", () => {
    expectMatchesWholeDocumentAtEveryTick(LONG_PROSE);
  }, 30_000);

  for (
    const [name, text] of [
      ["a fenced block mid-document", "para one\n\npara two\n\n```js\nx = 1\n```\n\nafter"],
      ["a mermaid fence", "a\n\n```mermaid\ngraph TD; A-->B\n```\n\nb"],
      ["a reference link defined after its use", "See [ref][a].\n\npara\n\n[a]: http://x.test\n"],
      ["a table", "| a | b |\n|---|---|\n| 1 | 2 |\n\ntail"],
      ["a loose list", "- one\n- two\n\n- three\n\nend"],
      // The underline arrives after the paragraph is already on screen, so a reader
      // that had settled the paragraph would render a heading as body text.
      ["a setext heading", "head\n===\n\nbody"],
      ["an unclosed fence", "intro\n\n```js\nconst x = 1\nconst y = 2"],
      // A nested fence is peeled out of the prose it was written in, so the slot's number has to
      // mean the same thing whether the run was parsed in one pass or grown over many.
      ["a fence nested in a list item", "- item:\n\n  ```js\n  x = 1\n  ```\n\nafter"],
      [
        "a nested fence far behind the live window",
        `${"filler paragraph.\n\n".repeat(60)}- one:\n\n  \`\`\`js\n  x = 1\n  \`\`\`\n\n- two\n`,
      ],
      // marked rewrites a half-typed bullet's own `raw` (`"- "` comes back `"-\n"`),
      // so a reader that demanded the tail tile itself exactly would bail out on
      // every list the model types. The tokens it SETTLES still tile; the last one
      // is allowed not to.
      ["a bullet caught mid-keystroke", `${"body paragraph.\n\n".repeat(50)}- item one\n- `],
    ] as const
  ) {
    it(`matches the whole-document reader across ${name}`, () => {
      expectMatchesWholeDocumentAtEveryTick(text);
    });
  }

  // `markdownSafePrefix` hides an unterminated marker by trimming back off the end,
  // so the text this is handed can be SHORTER than it was a tick ago. Settled work
  // has to survive that, and the answer has to stay right when it does not.
  it("survives a prefix that shrinks, as the marker trim makes it", () => {
    const blocks = createStreamingBlocks();
    const base = `${"filler paragraph.\n\n".repeat(60)}tail text `;
    for (const text of [base, `${base}**par`, base, `${base}**partial**`, `${base}**partial** more`]) {
      expect(blocks(text)).toEqual(toBlocks(text));
    }
  });

  it("restarts cleanly when the document is replaced rather than appended to", () => {
    const blocks = createStreamingBlocks();
    const first = LONG_PROSE.slice(0, 4000);
    expect(blocks(first)).toEqual(toBlocks(first));
    const unrelated = "# Something else entirely\n\nwith its own body.";
    expect(blocks(unrelated)).toEqual(toBlocks(unrelated));
  });

  // React renders twice under StrictMode, so the same content reaching the reader
  // twice must not advance its settled prefix past the answer it already gave.
  it("is idempotent for repeated content", () => {
    const blocks = createStreamingBlocks();
    const text = LONG_PROSE.slice(0, 5000);
    const once = blocks(text);
    expect(blocks(text)).toBe(once);
    expect(blocks(text)).toEqual(toBlocks(text));
  });

  // The saving is the point, and losing it is silent: the render stays correct and
  // just gets slow again. Asserted as object identity rather than a wall-clock
  // budget, which would flake on a loaded machine -- a settled block that is carried
  // forward is a settled block that was not parsed or sanitized again.
  it("carries settled blocks forward instead of rebuilding them", () => {
    const opening = "first paragraph\n\n```js\nconst x = 1\n```\n\n";
    const text = opening + LONG_PROSE;
    const blocks = createStreamingBlocks();
    // Only from the point where the opening is comfortably outside the live window.
    // Before that nothing has settled yet, and rebuilding is the correct behaviour.
    const seen = revealSteps(text)
      .map((prefix) => ({ prefix, out: blocks(prefix) }))
      .filter(({ prefix }) => prefix.length > 2000)
      .map(({ out }) => out);
    expect(seen.length).toBeGreaterThan(20);
    const [first] = seen;
    for (const out of seen) {
      expect(out[0]).toBe(first![0]);
      expect(out[1]).toBe(first![1]);
    }
    // ...and the last block is still being rebuilt, or nothing would ever update.
    expect(seen[seen.length - 1]!.at(-1)).not.toBe(first!.at(-1));
  });
});

describe("toBlocks", () => {
  const nested = "1. first:\n\n   ```ts\n   const x = 1\n   ```\n\n2. second\n";

  // Marked renders a fence inside a list item as a bare `<pre><code>`, which cannot be a React
  // component and is not highlighted, copyable, or narrow enough to stay inside the column.
  it("peels a fence out of the list item it was written in", () => {
    const blocks = toBlocks(nested);
    expect(blocks).toHaveLength(1);
    const [block] = blocks;
    expect(block!.kind).toBe("prose");
    if (block!.kind !== "prose") return;
    expect(block!.fences).toEqual([{ kind: "code", code: "const x = 1", lang: "ts" }]);
    expect(block!.html).toContain(`${FENCE_SLOT_ATTRIBUTE}="0"`);
    expect(block!.html).not.toContain("<pre");
    // The list is still one list: peeling replaces the fence in place rather than cutting the
    // prose run around it.
    expect(block!.html.match(/<ol/g)).toHaveLength(1);
  });

  it("reads a nested mermaid fence as mermaid, the way a top-level one is read", () => {
    const blocks = toBlocks("- chart:\n\n  ```mermaid\n  graph TD; A-->B\n  ```\n");
    const [block] = blocks;
    if (block!.kind !== "prose") throw new Error("expected one prose block");
    expect(block!.fences).toEqual([{ kind: "mermaid", code: "graph TD; A-->B" }]);
  });

  it("numbers every slot in a run, so two nested fences do not collide", () => {
    const blocks = toBlocks("- a:\n\n  ```js\n  1\n  ```\n\n- b:\n\n  ```js\n  2\n  ```\n");
    const [block] = blocks;
    if (block!.kind !== "prose") throw new Error("expected one prose block");
    expect(block!.fences.map((fence) => (fence.kind === "code" ? fence.code : null))).toEqual(["1", "2"]);
    expect(block!.html).toContain(`${FENCE_SLOT_ATTRIBUTE}="0"`);
    expect(block!.html).toContain(`${FENCE_SLOT_ATTRIBUTE}="1"`);
  });

  it("leaves a top-level fence a block of its own", () => {
    expect(toBlocks("intro\n\n```js\nx = 1\n```\n")).toEqual([
      { kind: "prose", html: expect.any(String), fences: [] },
      { kind: "code", code: "x = 1", lang: "js" },
    ]);
  });
});
