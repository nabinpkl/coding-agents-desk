import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdsSenderLease } from "@/push/pushSenderLease";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function leasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "push-lease-"));
  directories.push(directory);
  return join(directory, "web-push.sender");
}

describe("holdsSenderLease", () => {
  test("the first process to ask holds it, and keeps holding it", () => {
    const path = leasePath();
    expect(holdsSenderLease(path)).toBe(true);
    expect(holdsSenderLease(path)).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
  });

  test("a live holder keeps it from another process", () => {
    const path = leasePath();
    writeFileSync(path, `${process.ppid}\n`);
    expect(holdsSenderLease(path)).toBe(false);
  });

  test("a holder whose process is gone is taken over", () => {
    const path = leasePath();
    const finished = Bun.spawnSync(["true"]);
    writeFileSync(path, `${finished.pid}\n`);
    expect(holdsSenderLease(path)).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe(String(process.pid));
  });
});
