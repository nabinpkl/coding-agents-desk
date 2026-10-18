import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CommandRunner, resetProcessTableCache } from "@/tasks/processProbe";
import { cliSessionStatus } from "@/input/claudeCliSession";

const SESSION = "2adc3708-fadb-4e2f-a744-322df224faf4";
const PROC_START = "Fri Aug 14 17:10:48 2026";

/**
 * The ctime string the kernel prints locally for the same instant the registry records in UTC.
 * Built rather than written down so these hold in any timezone.
 */
const KERNEL_STAMP = (() => {
  const at = new Date(Date.UTC(2026, 7, 14, 17, 10, 48));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${days[at.getDay()]} ${months[at.getMonth()]} ${String(at.getDate()).padStart(2, " ")} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${at.getFullYear()}`
  );
})();

// The process table is shared and cached for a window, so without this one test's kernel would
// still be answering in the next one.
beforeEach(resetProcessTableCache);

const alive: CommandRunner = async () => `9672 1 ${KERNEL_STAMP} 0:00.00 claude`;

async function registry(row: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(join("/tmp", "adz-cli-"));
  await writeFile(
    join(directory, "9672.json"),
    JSON.stringify({ pid: 9672, sessionId: SESSION, cwd: "/x", procStart: PROC_START, entrypoint: "cli", ...row }),
  );
  return directory;
}

describe("cliSessionStatus", () => {
  test("names how a live session was launched", async () => {
    expect(await cliSessionStatus(SESSION, alive, await registry())).toEqual({
      entrypoint: "cli",
      tmuxSession: null,
      liveProcesses: 1,
    });
    expect(await cliSessionStatus(SESSION, alive, await registry({ entrypoint: "claude-desktop" }))).toEqual({
      entrypoint: "claude-desktop",
      tmuxSession: null,
      liveProcesses: 1,
    });
  });

  test("names nothing when no live process serves the session", async () => {
    expect(await cliSessionStatus(SESSION, async () => "", await registry())).toEqual({
      entrypoint: null,
      tmuxSession: null,
      liveProcesses: 0,
    });
  });
});
