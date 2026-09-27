/**
 * Parser and body tests for search tool results: grep content matches group by
 * file, file lists draw as rows, and anything unrecognized returns null so the
 * row keeps its generic `pre` rather than losing bytes to a guess.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  SearchResultBody,
  parseSearchResult,
  type SearchResultBody as SearchResultBodyData,
} from "@/features/activity-feed/blocks/SearchResultBody";

describe("parseSearchResult", () => {
  it("groups content matches by file, stripping the path and keeping the line", () => {
    const body = parseSearchResult(
      "Grep",
      "host/Provider.swift:38:    func manifest() throws -> Manifest {\n" +
        "host/Provider.swift:40:            return Manifest(assets: [])\n" +
        "packages/Wire.swift:561:    try roundTrip(Request.fetch(path: \"x\"))",
    );
    expect(body?.kind).toBe("matches");
    if (body?.kind !== "matches") return;
    expect(body.groups.map((group) => group.path)).toEqual([
      "host/Provider.swift",
      "packages/Wire.swift",
    ]);
    expect(body.groups[0]?.lines).toEqual([
      "38:    func manifest() throws -> Manifest {",
      "40:            return Manifest(assets: [])",
    ]);
  });

  it("reads opencode's lowercase tool names the same way", () => {
    expect(parseSearchResult("grep", "src/a.ts:1: x")?.kind).toBe("matches");
    expect(parseSearchResult("glob", "src/a.ts\nsrc/b.ts")?.kind).toBe("files");
  });

  it("leaves numbered prose and timestamps alone", () => {
    expect(parseSearchResult("Grep", "12:34: x")).toBeNull();
    expect(parseSearchResult("Grep", "10:30:45 something happened")).toBeNull();
  });

  it("leaves a paragraph with one stray match-shaped line alone", () => {
    expect(
      parseSearchResult("Grep", "first line\nsecond line\nsrc/a.ts:1: x\nfourth line"),
    ).toBeNull();
  });

  it("lifts the count line off a file list into a caption", () => {
    const body = parseSearchResult("Grep", "Found 3 files\nsrc/a.ts\nsrc/b.ts");
    expect(body).toEqual({ kind: "files", caption: "Found 3 files", paths: ["src/a.ts", "src/b.ts"] });
  });

  it("draws a captionless glob list as rows", () => {
    expect(parseSearchResult("Glob", "src/a.ts\nsrc/b.ts")).toEqual({
      kind: "files",
      caption: null,
      paths: ["src/a.ts", "src/b.ts"],
    });
  });

  it("draws an empty answer as its caption with no rows", () => {
    expect(parseSearchResult("Glob", "No files found")).toEqual({
      kind: "files",
      caption: "No files found",
      paths: [],
    });
  });

  it("answers null for other tools, empty text, and prose", () => {
    expect(parseSearchResult("Read", "src/a.ts:1: x")).toBeNull();
    expect(parseSearchResult("Grep", "   ")).toBeNull();
    expect(parseSearchResult("Grep", "something went wrong")).toBeNull();
  });
});

describe("SearchResultBody", () => {
  it("draws a file list as one truncated row per path under its caption", () => {
    const body: SearchResultBodyData = {
      kind: "files",
      caption: "Found 2 files",
      paths: ["src/a.ts", "src/b.ts"],
    };
    const { unmount } = render(<SearchResultBody body={body} />);
    expect(screen.getByText("Found 2 files")).toBeInTheDocument();
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
    unmount();
  });

  it("draws each match group under its file's basename with the match as code", () => {
    const body: SearchResultBodyData = {
      kind: "matches",
      groups: [{ path: "host/Provider.swift", lines: ["38:    func manifest() {"] }],
    };
    const { container, unmount } = render(<SearchResultBody body={body} />);
    expect(screen.getByText("Provider.swift")).toBeInTheDocument();
    // textContent rather than getByText: the highlighter tokenizes the match across spans.
    expect(container.textContent).toContain("func manifest()");
    expect(container.textContent).not.toContain("host/Provider.swift:38");
    unmount();
  });
});
