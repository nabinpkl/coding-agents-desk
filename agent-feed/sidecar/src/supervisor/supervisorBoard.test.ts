// The supervisor hears about the panel only through this file, so taking a dead writer for a live one
// would hold the sidecar for nothing, forever.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_STALE_MS, readPanelActivity, writePanelActivity } from "@/supervisor/supervisorBoard";

const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

function board(): string {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-board-"));
  made.push(dir);
  return dir;
}

test("what the panel writes is what the supervisor reads, while the panel is alive", () => {
  const dir = board();
  writePanelActivity(dir, { changedAt: 1_000, blocked: "main.tsx: Unexpected end of file" }, 50_000);
  expect(readPanelActivity(dir, 50_000 + BOARD_STALE_MS)).toEqual({
    changedAt: 1_000,
    blocked: "main.tsx: Unexpected end of file",
  });
});

// A dev server that stopped is not a quiet panel, it is no panel: the supervisor must not wait on it.
test("a panel that stopped heartbeating reads as no panel at all", () => {
  const dir = board();
  writePanelActivity(dir, { changedAt: 1_000, blocked: null }, 50_000);
  expect(readPanelActivity(dir, 50_001 + BOARD_STALE_MS)).toBeNull();
  expect(readPanelActivity(board(), 50_000)).toBeNull();
});
