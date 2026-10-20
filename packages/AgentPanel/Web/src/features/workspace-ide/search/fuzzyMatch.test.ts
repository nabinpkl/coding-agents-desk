import { describe, expect, it, vi } from "vitest";
import { type FuzzyWork, fuzzyFilter, fuzzyScore } from "@/features/workspace-ide/search/fuzzyMatch";

const PATHS = [
  "packages/AgentPanel/Web/src/features/workspace-ide/WorkspaceIdeSurface.tsx",
  "packages/AgentPanel/Web/src/features/workspace-ide/WorkspaceIdeStatusBar.tsx",
  "packages/AgentPanel/Web/src/features/workspace-ide/useWorkspaceIde.ts",
  "agent-feed/sidecar/src/workspace/workspaceService.ts",
  "agent-feed/sidecar/src/server.ts",
  "README.md",
  "tools/dev-login.sh",
];

const first = (query: string) => fuzzyFilter(PATHS, query, 5)[0]?.path;

describe("fuzzyFilter", () => {
  it("matches characters in order, not contiguously", () => {
    expect(first("wside")).toBe(PATHS[0]);
    expect(first("wsisb")).toBe(PATHS[1]);
  });

  it("prefers the file's own name to its folders", () => {
    expect(first("server")).toBe("agent-feed/sidecar/src/server.ts");
    expect(first("readme")).toBe("README.md");
  });

  it("prefers word starts and runs over scattered hits", () => {
    expect(first("useworkspaceide")).toBe(PATHS[2]);
    expect(first("devlogin")).toBe("tools/dev-login.sh");
  });

  it("drops a path missing any character, and returns nothing rather than a guess", () => {
    expect(fuzzyFilter(PATHS, "zzz", 5)).toEqual([]);
    expect(fuzzyScore("abc", "acb")).toBeNull();
  });

  it("splits on spaces into pieces that must all match, in any order", () => {
    expect(first("status ide")).toBe(PATHS[1]);
    expect(fuzzyFilter(PATHS, "sidecar readme", 5)).toEqual([]);
  });

  it("reports the matched positions for highlighting", () => {
    const match = fuzzyScore("src/server.ts", "srv")!;
    expect(match.positions.map((index) => "src/server.ts"[index]).join("")).toBe("srv");
    // On the name, not the folder that happens to spell it first.
    expect(match.positions[0]).toBeGreaterThanOrEqual(4);
  });

  // It runs over the whole file list on every keystroke, so its cost is checked here by counting
  // the work, not by a clock that a busy machine slows down.
  const many = Array.from(
    { length: 20_000 },
    (_, index) => `packages/area-${index % 97}/src/feature-${index % 13}/Component${index}.tsx`,
  );

  it("scores only the paths that hold the query in order, turning the rest away first", () => {
    const scored = (query: string) => {
      const work: FuzzyWork = { scored: 0 };
      fuzzyFilter(many, query, 50, work);
      return work.scored;
    };
    const holdInOrder = (query: string) => {
      const inOrder = new RegExp([...query].join(".*"));
      return many.filter((path) => inOrder.test(path.toLowerCase())).length;
    };
    expect(scored("f")).toBe(many.length);
    const specific = scored("comp123");
    expect(specific).toBe(holdInOrder("comp123"));
    expect(specific).toBeLessThan(many.length / 20);
  });

  it("reuses its scratch rows across paths instead of allocating them per path", () => {
    let allocated = 0;
    class CountedFloat64Array extends Float64Array {
      constructor(length: number) {
        super(length);
        allocated += 1;
      }
    }
    class CountedInt32Array extends Int32Array {
      constructor(length: number) {
        super(length);
        allocated += 1;
      }
    }
    vi.stubGlobal("Float64Array", CountedFloat64Array);
    vi.stubGlobal("Int32Array", CountedInt32Array);
    try {
      fuzzyFilter(many, "comp123", 50);
      fuzzyFilter(many, "f", 50);
    } finally {
      vi.unstubAllGlobals();
    }
    // Growing for a longer path takes three arrays; allocating per path would take over 60,000 here.
    expect(allocated).toBeLessThanOrEqual(3);
  });
});
