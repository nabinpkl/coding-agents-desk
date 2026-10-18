import { describe, it, expect } from "vitest";
import { toBlocks, scrubStyle } from "@/features/activity-feed/markdown/proseBlocks";

// Guards the security + correctness gaps surfaced in review of the synchronous
// Markdown renderer (ADR-0006). The module's prose path runs untrusted
// transcript HTML through DOMPurify; these assert the sanitizer config and the
// fence-language handling behave as intended.

describe("scrubStyle", () => {
  it("strips overlay-enabling declarations (clickjacking vector)", () => {
    const out = scrubStyle("position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;background:red");
    expect(out).not.toMatch(/position/i);
    expect(out).not.toMatch(/z-index/i);
    expect(out).not.toMatch(/inset/i);
  });

  it("drops url() and expression() bearing declarations", () => {
    expect(scrubStyle("background:url(http://evil/x.png)")).toBe("");
    expect(scrubStyle("width:expression(alert(1))")).toBe("");
  });

  it("keeps KaTeX layout declarations untouched", () => {
    const out = scrubStyle("height:2.5em;vertical-align:-1.2em;top:-3em;margin-right:0.05em");
    expect(out).toContain("height:2.5em");
    expect(out).toContain("vertical-align:-1.2em");
    expect(out).toContain("top:-3em");
    expect(out).toContain("margin-right:0.05em");
  });
});

describe("toBlocks", () => {
  const proseHtml = (md: string) =>
    toBlocks(md)
      .map((b) => (b.kind === "prose" ? b.html : ""))
      .join("\n");

  it("neutralizes a position:fixed overlay smuggled in raw-HTML prose", () => {
    const html = proseHtml(
      '<div style="position:fixed;top:0;width:100vw;height:100vh;z-index:9999;background:red">x</div>',
    );
    expect(html).not.toMatch(/position\s*:\s*fixed/i);
    expect(html).not.toMatch(/z-index/i);
  });

  it("strips script tags and inline event handlers from raw HTML", () => {
    const html = proseHtml('<img src=x onerror="alert(1)"> <script>alert(2)</script>');
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/<script/i);
  });

  it("detects mermaid fences case-insensitively", () => {
    const blocks = toBlocks("```Mermaid\ngraph TD; A-->B\n```");
    expect(blocks.some((b) => b.kind === "mermaid")).toBe(true);
  });

  it("ignores fence info-string attributes when picking a grammar", () => {
    const blocks = toBlocks("```js {1,3-5}\nconst x = 1\n```");
    const code = blocks.find((b) => b.kind === "code");
    expect(code?.kind === "code" && code.lang).toBe("js");
  });

  it("resolves reference-style links across a code-block split", () => {
    const md = [
      "See the [docs][d].",
      "",
      "```ts",
      "const x = 1",
      "```",
      "",
      "More in the [docs][d].",
      "",
      "[d]: https://example.com",
    ].join("\n");
    const html = proseHtml(md);
    expect((html.match(/href="https:\/\/example\.com"/g) ?? []).length).toBe(2);
  });
});
