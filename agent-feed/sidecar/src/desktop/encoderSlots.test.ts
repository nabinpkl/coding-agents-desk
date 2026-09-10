import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireEncoderSlot } from "@/desktop/encoderSlots";
import { helperBinary } from "@/desktop/helperBinary";

function installedHelper(directory: string, content: string, mtimeMs: number) {
  const path = join(directory, "grid-encoder");
  writeFileSync(path, content, { mode: 0o755 });
  utimesSync(path, new Date(), new Date(mtimeMs));
  return helperBinary(path);
}

describe("encoder slots", () => {
  test("each occupied slot moves the next spawn to its own copy", () => {
    const root = mkdtempSync(join(tmpdir(), "encoder-slots-"));
    const source = installedHelper(root, "#!/bin/sh\nexit 0\n", 1_700_000_000_000);
    const slots = join(root, "slots");
    const busy = new Set<string>();
    const first = acquireEncoderSlot(source, slots, (path) => busy.has(path));
    busy.add(first);
    const second = acquireEncoderSlot(source, slots, (path) => busy.has(path));
    expect(first).toBe(join(slots, "grid-encoder.0"));
    expect(second).toBe(join(slots, "grid-encoder.1"));
    expect(readFileSync(second, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    expect(statSync(second).mode & 0o111).not.toBe(0);
    // Freed, the first slot is handed out again before a third copy is made.
    busy.delete(first);
    expect(acquireEncoderSlot(source, slots, (path) => busy.has(path))).toBe(first);
  });

  test("a reinstalled helper refreshes a free slot's copy", () => {
    const root = mkdtempSync(join(tmpdir(), "encoder-slots-"));
    const slots = join(root, "slots");
    const first = acquireEncoderSlot(installedHelper(root, "old", 1_700_000_000_000), slots, () => false);
    expect(readFileSync(first, "utf8")).toBe("old");
    const updated = installedHelper(root, "new", 1_700_000_005_000);
    expect(acquireEncoderSlot(updated, slots, () => false)).toBe(first);
    expect(readFileSync(first, "utf8")).toBe("new");
    expect(Math.abs(statSync(first).mtimeMs - updated.mtimeMs)).toBeLessThan(1);
  });

  test("a missing helper is refused rather than copied as nothing", () => {
    const root = mkdtempSync(join(tmpdir(), "encoder-slots-"));
    expect(() => acquireEncoderSlot(helperBinary(join(root, "absent")), join(root, "slots"), () => false))
      .toThrow(/no installed helper/);
  });
});
