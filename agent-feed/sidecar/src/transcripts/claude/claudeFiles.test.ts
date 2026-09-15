import { expect, test } from "bun:test";
import { toolFilePaths } from "@/transcripts/claude/claudeFiles";

test("a call that hands files over contributes all of them, in its own order", () => {
  expect(toolFilePaths({
    files: ["/tmp/s/edges-9.png", "/tmp/s/report.md"],
    caption: "Two things",
    status: "normal",
  })).toEqual(["/tmp/s/edges-9.png", "/tmp/s/report.md"]);
});

test("a call that works on one file contributes it only when it is a picture", () => {
  // The row already says `Read main.ts`, and there is no picture to draw for it.
  expect(toolFilePaths({ file_path: "/repo/src/main.ts" })).toEqual([]);
  expect(toolFilePaths({ file_path: "/repo/shots/after.png" })).toEqual(["/repo/shots/after.png"]);
  expect(toolFilePaths({ path: "/repo/shots/before.webp" })).toEqual(["/repo/shots/before.webp"]);
});

test("a command contributes the pictures it names, which is where a render comes from", () => {
  // The case this exists for: nothing else in the transcript names the file the command wrote.
  expect(toolFilePaths({
    command: "cd /repo && python3 render.py --out /tmp/s/map.png && open /tmp/s/map.png",
  })).toEqual(["/tmp/s/map.png"]);
  // Quoted, and inside a redirect.
  expect(toolFilePaths({ command: "cp 'a.png' \"/tmp/s/b.png\" > /dev/null" }))
    .toEqual(["/tmp/s/b.png"]);
  // Nothing to draw: relative paths, and files that are not pictures.
  expect(toolFilePaths({ command: "ls -la out.png && cat /etc/hosts" })).toEqual([]);
});

test("names each file once, and stops before a command's whole directory", () => {
  expect(toolFilePaths({
    files: ["/tmp/s/one.png"],
    command: "open /tmp/s/one.png",
  })).toEqual(["/tmp/s/one.png"]);

  const many = Array.from({ length: 12 }, (_, i) => `/tmp/s/${i}.png`);
  expect(toolFilePaths({ command: many.join(" ") })).toHaveLength(8);
});

test("a call that names no file contributes none", () => {
  expect(toolFilePaths(undefined)).toEqual([]);
  expect(toolFilePaths({ pattern: "TODO", files: "not a list" })).toEqual([]);
});
