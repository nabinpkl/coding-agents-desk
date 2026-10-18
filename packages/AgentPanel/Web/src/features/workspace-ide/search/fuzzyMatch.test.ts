import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "@/features/workspace-ide/search/fuzzyMatch";

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

  it("keeps up with a large list", () => {
    const many = Array.from(
      { length: 20_000 },
      (_, index) => `packages/area-${index % 97}/src/feature-${index % 13}/Component${index}.tsx`,
    );
    const started = performance.now();
    fuzzyFilter(many, "comp123", 50);
    fuzzyFilter(many, "f", 50);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
