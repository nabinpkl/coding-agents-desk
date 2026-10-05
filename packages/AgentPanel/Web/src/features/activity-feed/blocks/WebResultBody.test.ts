/**
 * The web result parser: fetches are Markdown by the tool's contract, searches lose their frame,
 * and a frame that does not parse returns null so the row keeps its generic `pre`.
 */

import { describe, expect, it } from "vitest";
import { parseWebResult } from "@/features/activity-feed/blocks/WebResultBody";

const SEARCH =
  'Web search results for query: "q"\n\n' +
  'Links: [{"title":"One","url":"https://a.example/1"},{"url":"https://b.example/2"}]\n\n' +
  "First summary.\n\n" +
  'Links: [{"title":"Three","url":"https://c.example/3"}]\n\n' +
  "Second summary.\n\n" +
  "REMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.";

describe("parseWebResult", () => {
  it("takes a fetch result as Markdown, whatever it says", () => {
    expect(parseWebResult("WebFetch", "# Title\n\nbody")).toEqual({ kind: "fetch", markdown: "# Title\n\nbody" });
    expect(parseWebResult("webfetch", "plain")?.kind).toBe("fetch");
  });

  it("collects every Links line and drops the frame from the prose", () => {
    const body = parseWebResult("WebSearch", SEARCH);
    expect(body?.kind).toBe("search");
    if (body?.kind !== "search") return;
    expect(body.links).toEqual([
      { title: "One", url: "https://a.example/1" },
      // A link with no title is named by its address rather than dropped.
      { title: "https://b.example/2", url: "https://b.example/2" },
      { title: "Three", url: "https://c.example/3" },
    ]);
    expect(body.markdown).toBe("First summary.\n\nSecond summary.");
  });

  it("keeps the pre for a search whose frame it does not recognise", () => {
    expect(parseWebResult("WebSearch", "no frame here")).toBeNull();
    expect(parseWebResult("WebSearch", 'Web search results for query: "q"\nLinks: not json')).toBeNull();
    // A link that is not http(s) is not something to put in an href.
    expect(parseWebResult("WebSearch", 'Web search results for query: "q"\nLinks: [{"title":"x","url":"javascript:alert(1)"}]')).toBeNull();
  });

  it("leaves every other tool, and an empty result, alone", () => {
    expect(parseWebResult("Bash", "# a comment")).toBeNull();
    expect(parseWebResult(undefined, "# a")).toBeNull();
    expect(parseWebResult("WebFetch", "   ")).toBeNull();
  });
});
