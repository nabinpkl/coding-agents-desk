/**
 * The supervisor's half of the rendezvous board.
 *
 * Two processes share this file and neither can see the other's memory: the supervisor writes it,
 * and the sidecar reads it back to answer `/api/config` for a panel that may be on another machine.
 * What matters is that a reader can tell a supervisor that is thinking from one that died, which is
 * the only thing standing between a held sidecar and a panel reporting a dead process's last words
 * as current.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSupervisorDescriptor,
  readSupervisorDescriptor,
  supervisorDescriptorPath,
  writeSupervisorDescriptor,
} from "@/sidecarRegistry";

/** Created here and removed by the name this run was handed, never a glob and never a parent. */
const made: string[] = [];
function board(): string {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-board-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

test("a supervisor that has just published reads back as it published", () => {
  const dir = board();
  writeSupervisorDescriptor({ held: true, blocked: "sessionRoutes.ts: Syntax Error" }, dir);
  expect(readSupervisorDescriptor(dir)).toEqual({
    held: true,
    blocked: "sessionRoutes.ts: Syntax Error",
  });
});

test("a machine with no supervisor says so rather than failing", () => {
  expect(readSupervisorDescriptor(board())).toBeNull();
});

// The case this exists for: a supervisor that died leaves its last state on disk, and showing that
// as live would put a frozen report on the one row whose job is to say what is current.
test("a supervisor that stopped heartbeating reads as no supervisor at all", () => {
  const dir = board();
  writeSupervisorDescriptor({ held: true, blocked: "half a file" }, dir);
  expect(readSupervisorDescriptor(dir, Date.now() + 16_000)).toBeNull();
  // Still live a heartbeat or two late, so one missed tick is not reported as a death.
  expect(readSupervisorDescriptor(dir, Date.now() + 6_000)?.held).toBe(true);
});

test("a descriptor caught mid-write or hand-edited reads as absent", () => {
  const dir = board();
  writeFileSync(supervisorDescriptorPath(dir), '{"held":tr');
  expect(readSupervisorDescriptor(dir)).toBeNull();
});

test("a field that is not the contract falls back rather than travelling", () => {
  const dir = board();
  writeFileSync(
    supervisorDescriptorPath(dir),
    JSON.stringify({ held: "yes", blocked: 12, heartbeat: Date.now() }),
  );
  expect(readSupervisorDescriptor(dir)).toEqual({ held: false, blocked: null });
});

test("withdrawing takes it off the board now rather than aging it out", () => {
  const dir = board();
  writeSupervisorDescriptor({ held: false, blocked: null }, dir);
  clearSupervisorDescriptor(dir);
  expect(readSupervisorDescriptor(dir)).toBeNull();
});
