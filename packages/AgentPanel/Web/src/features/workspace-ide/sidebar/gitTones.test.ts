import { describe, expect, it } from "vitest";
import type { WorkspaceGitEntry } from "@agentdesk/agent-feed-wire";
import { changedFileCount, gitDecorationTone, sourceControlSections } from "@/features/workspace-ide/sidebar/gitTones";

function entry(relativePath: string, indexStatus: string | null, workTreeStatus: string | null): WorkspaceGitEntry {
  return { relativePath, indexStatus, workTreeStatus };
}

describe("gitDecorationTone", () => {
  it("says nothing about an unchanged path", () => {
    expect(gitDecorationTone(null)).toBe(null);
    expect(gitDecorationTone("")).toBe(null);
    expect(gitDecorationTone("  ")).toBe(null);
  });

  it("lets ignored win outright, because it is not a change to act on", () => {
    expect(gitDecorationTone("!!")).toBe("ignored");
    expect(gitDecorationTone("M!")).toBe("ignored");
  });

  it("reads an unmerged pair as one conflict rather than two edits", () => {
    for (const code of ["UU", "AA", "DD", "AU", "UA", "DU", "UD"]) {
      expect(gitDecorationTone(code)).toBe("conflicted");
    }
  });

  it("collapses a two-letter code to its most severe half", () => {
    expect(gitDecorationTone("MM")).toBe("modified");
    expect(gitDecorationTone("A ")).toBe("added");
    expect(gitDecorationTone(" D")).toBe("deleted");
    expect(gitDecorationTone("??")).toBe("untracked");
    // Staged add, then modified in the worktree: modified is the more severe of the two.
    expect(gitDecorationTone("AM")).toBe("modified");
  });
});

describe("sourceControlSections", () => {
  it("is empty for a clean tree", () => {
    expect(sourceControlSections([])).toEqual([]);
  });

  it("files a conflict once, under conflicts", () => {
    const sections = sourceControlSections([entry("both.ts", "U", "U")]);
    expect(sections.map((section) => section.id)).toEqual(["conflicts"]);
    expect(sections[0]!.rows[0]!.letters).toBe("UU");
  });

  it("files a path edited in both places under staged AND changes", () => {
    const sections = sourceControlSections([entry("both.ts", "M", "M")]);
    expect(sections.map((section) => section.id)).toEqual(["staged", "changes"]);
    expect(sections.every((section) => section.rows[0]!.path === "both.ts")).toBe(true);
  });

  it("drops ignored paths, which are on the wire only to dim the explorer", () => {
    expect(sourceControlSections([entry("build/out.js", "!", "!")])).toEqual([]);
  });

  it("orders sections by how they get resolved", () => {
    const sections = sourceControlSections([
      entry("new.ts", "?", "?"),
      entry("staged.ts", "A", null),
      entry("changed.ts", null, "M"),
      entry("conflict.ts", "U", "U"),
    ]);
    expect(sections.map((section) => section.id)).toEqual(["conflicts", "staged", "changes", "untracked"]);
  });

  it("splits a row into a name and the directory that gives way first", () => {
    const [section] = sourceControlSections([entry("src/app/main.tsx", "M", null)]);
    expect(section!.rows[0]).toMatchObject({
      path: "src/app/main.tsx",
      name: "main.tsx",
      directory: "src/app",
      letters: "M",
      tone: "modified",
    });
  });

  it("gives a root-level file an empty directory rather than a slash", () => {
    const [section] = sourceControlSections([entry("README.md", null, "M")]);
    expect(section!.rows[0]!.directory).toBe("");
  });
});

describe("changedFileCount", () => {
  it("counts nothing when git has nothing to say", () => {
    expect(changedFileCount([])).toBe(0);
  });

  it("counts a file once when it is changed in both the index and the worktree", () => {
    // The section list shows this path twice, under Staged Changes and under Changes, because it
    // is two things to resolve. The badge answers a different question: how many files.
    expect(changedFileCount([entry("src/a.ts", "M", "M")])).toBe(1);
  });

  it("leaves ignored paths out, the way the section list does", () => {
    expect(
      changedFileCount([
        entry("src/a.ts", null, "M"),
        entry("build/out.js", "!", "!"),
        entry("node_modules/x", null, "!"),
      ]),
    ).toBe(1);
  });

  it("counts every kind of change, not only the tracked ones", () => {
    expect(
      changedFileCount([
        entry("conflict.ts", "U", "U"),
        entry("staged.ts", "A", null),
        entry("changed.ts", null, "M"),
        entry("new.ts", "?", "?"),
      ]),
    ).toBe(4);
  });

  it("ignores an entry with no path rather than counting an empty string", () => {
    expect(changedFileCount([entry("", "M", null)])).toBe(0);
  });
});
