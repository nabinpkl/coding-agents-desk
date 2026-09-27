import { describe, expect, it } from "vitest";
import { describeEditChange } from "@/features/activity-feed/blocks/diff/describeEditChange";

describe("describeEditChange", () => {
  it("names added functions with counts", () => {
    expect(
      describeEditChange(
        "export function old() {\n  return 1;\n}",
        "export function old() {\n  return 1;\n}\nexport function prettifyPattern(p: string) {\n  return p;\n}",
      ),
    ).toBe("adds prettifyPattern(), +3/-0");
  });

  it("tells added apart from removed", () => {
    expect(
      describeEditChange(
        "function a() {\n  return 1;\n}\nfunction gone() {\n  return 2;\n}",
        "function a() {\n  return 3;\n}\nfunction b() {\n  return 4;\n}",
      ),
    ).toBe("adds b(), removes gone(), +3/-3");
  });

  it("attributes a top-level const edit to the const", () => {
    expect(describeEditChange("const x = 1;", "const x = 2;")).toBe("x(): const x = 1; → const x = 2;");
  });

  it("says nothing when only whitespace moves", () => {
    expect(describeEditChange("const x = 1;\n", "const x = 1;\n\n  \n")).toBeNull();
  });

  it("reads python and methods too", () => {
    expect(describeEditChange("", "def parse(path):\n  return open(path).read()"))
      .toBe("adds parse(), +2/-0");
  });

  it("attributes body edits to their function with counts", () => {
    const oldText = [
      "function dirLabel(cwd: string | null): string {",
      '  if (!cwd) return "unknown";',
      "  const parts = cwd.split(Filter(Boolean);",
      "}",
    ].join("\n");
    const newText = [
      "function dirLabel(cwd: string | null): string {",
      '  if (!cwd) return "unknown";',
      "  const parts = cwd.split(Filter(Boolean);",
      '  if (parts.length === 0) return "root";',
      "}",
    ].join("\n");
    expect(describeEditChange(oldText, newText))
      .toBe('dirLabel(): +if (parts.length === 0) return "root";');
  });

  it("shows fragments for tiny diffs", () => {
    expect(
      describeEditChange(
        "function f() {\n  return 1;\n}",
        "function f() {\n  return 2;\n}",
      ),
    ).toBe("f(): return 1; → return 2;");
  });

  it("flags major additions", () => {
    const body = Array.from({ length: 55 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    expect(describeEditChange("function big() {\n}", `function big() {\n${body}\n}`))
      .toBe("major addition to big(), +55/-0");
  });

  it("names dropped top-level calls when no function is in scope", () => {
    expect(
      describeEditChange(
        "await serveWrite(`x`);\nawait stream.dispose();",
        "await serveWrite(`x`);",
      ),
    ).toBe("drops stream.dispose(), +0/-1");
  });

  it("names added calls with counts", () => {
    expect(
      describeEditChange("start();", "start();\nstopAll();"),
    ).toBe("calls stopAll(), +1/-0");
  });

  it("names added and dropped imports", () => {
    expect(
      describeEditChange("", `import { a, b } from "./mod";`),
    ).toBe("imports a, b from ./mod, +1/-0");
    expect(
      describeEditChange(`import x from "y";\nuse(x);`, `use(x);`),
    ).toBe("drops x from y, +0/-1");
    expect(
      describeEditChange("", `from os import path`),
    ).toBe("imports path from os, +1/-0");
  });

  it("names comment-only edits with an excerpt", () => {
    expect(describeEditChange("// retry after failure", "// retry with backoff"))
      .toBe("comment: retry after failure → retry with backoff");
    expect(describeEditChange("start();", "start();\n// begin polling"))
      .toBe("comment: +begin polling");
    expect(describeEditChange("const x = 1; // timeout", "const x = 1; // retries"))
      .toBe("comment in x(): timeout → retries");
  });

  it("attributes comment edits to their function", () => {
    const oldText = "function f() {\n  // old note\n  return 1;\n}";
    const newText = "function f() {\n  // new note\n  return 1;\n}";
    expect(describeEditChange(oldText, newText))
      .toBe("comment in f(): old note → new note");
  });

  it("never reads a comment as a call", () => {
    expect(describeEditChange("// a", "// call foo() on retry"))
      .toBe("comment: a → call foo() on retry");
  });

  it("reads hash comments but guards preprocessor directives", () => {
    expect(describeEditChange("# old", "# new", "a.py"))
      .toBe("comment: old → new");
    expect(describeEditChange("#include <a>", "#include <b>")).toBe("#include <a> → #include <b>");
  });

  it("leaves markdown headings out of the comment tier", () => {
    expect(describeEditChange("# Title", "# New title", "docs/guide.md")).toBe("# Title → # New title");
  });

  it("appends counts to larger comment edits", () => {
    expect(describeEditChange("// a\n// b\n// c", "// d\n// e\n// f"))
      .toBe("comment: a / b / c → d / e / f, +3/-3");
  });

  it("names argument-only call changes", () => {    expect(
      describeEditChange(
        `? describeEditChange(editOld ?? "", editNew ?? "")`,
        `? describeEditChange(editOld ?? "", editNew ?? "", editPath ?? undefined)`,
      ),
    ).toBe("updates describeEditChange(): +editPath ?? undefined, +1/-1");
    expect(describeEditChange("f(a);", "f(b);")).toBe("updates f(): a → b, +1/-1");
    expect(describeEditChange("f(a, b);", "f(a);")).toBe("updates f(): -b, +1/-1");
  });

  it("attributes edits under file-level declarations", () => {
    expect(
      describeEditChange("interface Props {\n  a: string;\n}", "interface Props {\n  a: number;\n}"),
    ).toBe("Props(): a: string; → a: number;");
    expect(
      describeEditChange("type Mode = \"a\";\n", "type Mode = \"a\" | \"b\";\n"),
    ).toBe("Mode(): type Mode = \"a\"; → type Mode = \"a\" | \"b\";");
  });

  it("never lets an indented const shadow its function", () => {
    expect(
      describeEditChange(
        "function f() {\n  const y = 1;\n  return y;\n}",
        "function f() {\n  const y = 1;\n  return y + 1;\n}",
      ),
    ).toBe("f(): return y; → return y + 1;");
  });

  it("shows the words that moved when no tier fires", () => {
    expect(
      describeEditChange(
        '      className="absolute inset-x-3 top-3 z-40"',
        '      className="absolute inset-x-3 top-0 z-40"',
      ),
    ).toBe('className="absolute inset-x-3 top-3 z-40" → className="absolute inset-x-3 top-0 z-40"');
    expect(describeEditChange("x", "x\ny")).toBe("+y");
    expect(describeEditChange("x\ny", "x")).toBe("-y");
  });

  it("stays on counts past two lines with no scope", () => {
    expect(describeEditChange("", "<div>\n<span>\n</div>")).toBe("+3/-0");
  });

  it("names bare identifier-list removals past the tiny bound", () => {
    const oldText = [
      "  storeCanvasScroll,",
      "  storeFatherHeight,",
      "  storeFatherOpen,",
      "  storeFatherWidth,",
      "  storeHiddenMachines,",
    ].join("\n");
    const newText = "  storeCanvasScroll,\n  storeHiddenMachines,";
    expect(describeEditChange(oldText, newText)).toBe(
      "drops storeFatherHeight, storeFatherOpen, storeFatherWidth, +0/-3",
    );
  });
});
