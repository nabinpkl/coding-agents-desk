/**
 * @vitest-environment node
 *
 * Whether React Compiler compiles every component and hook in the panel, rather than skipping some
 * without a word.
 *
 * The compiler leaves a function as written whenever it cannot prove its memoization safe -- a
 * dependency list missing a setter, a `finally`, a rule-suppression comment -- and nothing at
 * runtime says so: the panel works, just re-rendering what it would have skipped. This runs the
 * compiler the dev server uses over `src` and fails on each function it would skip. A file that
 * opts out on purpose says so with `"use no memo"` and the reason beside it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "oxc-transform-react";
import { describe, expect, it } from "vitest";

const SOURCE = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$|\.d\.ts$/.test(name) ? [path] : [];
  });
}

/** Each function the compiler would skip in `code`, as `path:line: reason`. */
async function skipsIn(path: string, code: string): Promise<string[]> {
  const result = await transform(path, code, {
    jsx: { runtime: "automatic", development: true },
    reactCompiler: { reportDiagnostics: true },
    sourcemap: false,
  });
  const bytes = Buffer.from(code);
  return result.errors.map((error) => {
    const at = error.labels[0]?.start ?? 0;
    const line = bytes.subarray(0, at).toString().split("\n").length;
    return `${path.slice(SOURCE.length)}:${line}: ${error.message.split("\n")[0]}`;
  });
}

describe("React Compiler over the panel", () => {
  it("compiles every component and hook, outside files that opt out by name", async () => {
    const skips: string[] = [];
    for (const path of sourceFiles(SOURCE)) {
      const code = readFileSync(path, "utf8");
      if (code.includes('"use no memo"')) continue;
      skips.push(...(await skipsIn(path, code)));
    }
    expect(skips).toEqual([]);
  }, 60_000);

  it("reports a skip when there is one, so an empty list above means something", async () => {
    const skipped = [
      'import { useCallback } from "react";',
      'import { useStateFor } from "@/hooks/state/useStateFor";',
      "export function Probe({ id }: { id: string }) {",
      "  const [on, setOn] = useStateFor(id, () => false);",
      "  const flip = useCallback(() => setOn(true), []);",
      "  return <button onClick={flip}>{String(on)}</button>;",
      "}",
    ].join("\n");
    expect(await skipsIn(`${SOURCE}Probe.tsx`, skipped)).toEqual([
      "Probe.tsx:5: Existing memoization could not be preserved",
    ]);
  });
});
