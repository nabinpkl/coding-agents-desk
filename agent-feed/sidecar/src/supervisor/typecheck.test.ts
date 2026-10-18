import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeTypeError, introduced, parseErrors, typeErrors, type TypeCheckError } from "@/supervisor/typecheck";

function error(file: string, line: number, message: string, code = "TS2339"): TypeCheckError {
  return { file, line, code, message };
}

describe("reading the compiler's answer", () => {
  test("takes each error line, with its file made absolute, and nothing else", () => {
    const output = [
      "src/app/AgentPanelApp.tsx(105,40): error TS2345: Argument of type 'Feed' is not assignable to parameter of type 'readonly Machine[]'.",
      "",
      "Found 1 error.",
    ].join("\n");
    expect(parseErrors(output, "/repo/web")).toEqual([
      error(
        "/repo/web/src/app/AgentPanelApp.tsx",
        105,
        "Argument of type 'Feed' is not assignable to parameter of type 'readonly Machine[]'.",
        "TS2345",
      ),
    ]);
  });
});

// A tree that was already failing to check must not hold every change after it; only what an edit
// introduced is a reason to keep the running code.
describe("what an edit introduced", () => {
  const old = error("/repo/src/a.ts", 10, "Property 'x' does not exist on type 'Y'.");

  test("is nothing when the same error has only moved", () => {
    expect(introduced([old], [{ ...old, line: 14 }])).toEqual([]);
  });

  test("is the new error, and a second copy of an old one", () => {
    const fresh = error("/repo/src/b.ts", 3, "Cannot find name 'opencodeGoSource'.", "TS2304");
    expect(introduced([old], [old, fresh, { ...old, line: 30 }])).toEqual([fresh, { ...old, line: 30 }]);
  });

  test("says where, in one line, and how many more", () => {
    expect(describeTypeError(old, 2)).toBe("a.ts:10: Property 'x' does not exist on type 'Y'. (and 2 more)");
  });
});

describe("a check that cannot run", () => {
  test("says so rather than reporting a clean tree", async () => {
    const work = mkdtempSync(join(tmpdir(), "typecheck-"));
    try {
      writeFileSync(join(work, "tsconfig.json"), "{}");
      expect(await typeErrors(join(work, "tsconfig.json"))).toEqual({
        failed: "no TypeScript installed beside tsconfig.json",
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
