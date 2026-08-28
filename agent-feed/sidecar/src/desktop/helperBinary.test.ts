import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helperBinary, missingHelperMessage } from "./helperBinary.ts";

test("only a usable installed executable is reported available", () => {
  const root = mkdtempSync(join(tmpdir(), "agentdesk-helper-probe-"));
  const path = join(root, "grid-encoder");
  try {
    expect(helperBinary(path)).toEqual({ path, mtimeMs: 0, exists: false });
    mkdirSync(path);
    expect(helperBinary(path).exists).toBe(false);
    rmSync(path, { recursive: true });
    writeFileSync(path, "", { mode: 0o755 });
    expect(helperBinary(path).exists).toBe(false);
    writeFileSync(path, "fixture executable");
    chmodSync(path, 0o644);
    expect(helperBinary(path).exists).toBe(false);
    chmodSync(path, 0o755);
    expect(helperBinary(path).exists).toBe(true);
    expect(helperBinary(path).mtimeMs).toBeGreaterThan(0);
    expect(missingHelperMessage(path)).toContain("just grid-encoder-install");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
