// The two processes coordinating a change read each other only through these files, so a reader that
// takes a dead writer for a live one holds a panel or a sidecar for nothing, forever.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  BOARD_STALE_MS,
  readPanelActivity,
  readSidecarStartedAt,
  readSupervisorPending,
  supervisorDescriptorPath,
  writePanelActivity,
} from "@/supervisor/supervisorBoard";

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

test("reads the supervisor's own state, and nothing from one that stopped", () => {
  const dir = board();
  writeFileSync(supervisorDescriptorPath(dir), JSON.stringify({ held: true, blocked: null, mode: "auto", heartbeat: 10_000 }));
  expect(readSupervisorPending(dir, 12_000)).toEqual({ held: true, mode: "auto" });
  expect(readSupervisorPending(dir, 10_001 + BOARD_STALE_MS)).toBeNull();
});

test("reads when the sidecar now on the board started", () => {
  const dir = board();
  const file = join(dir, `${userInfo().username}.json`);
  writeFileSync(file, JSON.stringify({ startedAt: 7_000, heartbeat: 9_000 }));
  expect(readSidecarStartedAt(dir, 9_500)).toBe(7_000);
  writeFileSync(file, "{ half a fi");
  expect(readSidecarStartedAt(dir, 9_500)).toBeNull();
});
