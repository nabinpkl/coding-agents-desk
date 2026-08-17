import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "./processProbe.ts";
import { liveSessionProcesses, sessionOwner } from "./sessionRegistry.ts";

const SESSION = "2adc3708-fadb-4e2f-a744-322df224faf4";

async function registryWith(records: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "adz-registry-"));
  for (const [name, value] of Object.entries(records)) {
    await writeFile(join(directory, name), JSON.stringify(value));
  }
  return directory;
}

describe("liveSessionProcesses", () => {
  const procStart = "Fri Aug 14 17:10:48 2026";
  // Rebuild the local-time ctime string the kernel would print for that instant, so this test
  // holds in any timezone rather than only in the one it was written in.
  const kernelStamp = (() => {
    const at = new Date(Date.UTC(2026, 7, 14, 17, 10, 48));
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${days[at.getDay()]} ${months[at.getMonth()]} ${String(at.getDate()).padStart(2, " ")} ` +
      `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${at.getFullYear()}`;
  })();

  test("accepts a record whose start time the kernel confirms", async () => {
    const directory = await registryWith({
      "9672.json": { pid: 9672, sessionId: SESSION, cwd: "/Users/dev/projects/agent-desk", procStart },
    });
    const run: CommandRunner = async () => kernelStamp;
    expect(await liveSessionProcesses(run, directory)).toEqual([
      {
        pid: 9672,
        sessionId: SESSION,
        cwd: "/Users/dev/projects/agent-desk",
        startedAt: Date.UTC(2026, 7, 14, 17, 10, 48),
      },
    ]);
  });

  test("a dead pid is skipped, because stale records are the normal state of that directory", async () => {
    const directory = await registryWith({
      "9672.json": { pid: 9672, sessionId: SESSION, cwd: "/x", procStart },
    });
    const run: CommandRunner = async () => ""; // ps prints nothing for a pid that is gone
    expect(await liveSessionProcesses(run, directory)).toEqual([]);
  });

  test("a reused pid is refused, which is what procStart is for", async () => {
    const directory = await registryWith({
      "9672.json": { pid: 9672, sessionId: SESSION, cwd: "/x", procStart },
    });
    // Same pid, a process that started an hour later: some unrelated program now owns it.
    const run: CommandRunner = async () => "Fri Aug 14 18:10:48 2026";
    expect(await liveSessionProcesses(run, directory)).toEqual([]);
  });

  test("a malformed record does not take the whole scan down", async () => {
    const directory = await registryWith({
      "9672.json": { pid: 9672, sessionId: SESSION, cwd: "/x", procStart },
      "bad.json": { nothing: true },
    });
    await writeFile(join(directory, "notjson.json"), "{{{");
    const run: CommandRunner = async () => kernelStamp;
    expect(await liveSessionProcesses(run, directory)).toHaveLength(1);
  });

  test("a missing registry is an empty answer, not a throw", async () => {
    expect(await liveSessionProcesses(async () => "", "/nonexistent/agent-desk-test")).toEqual([]);
  });
});

describe("sessionOwner", () => {
  test("answers null for a session no live process is serving", async () => {
    const directory = await registryWith({
      "9672.json": {
        pid: 9672,
        sessionId: "someone-else",
        cwd: "/x",
        procStart: "Fri Aug 14 17:10:48 2026",
      },
    });
    expect(await sessionOwner(SESSION, async () => "", directory)).toBeNull();
  });
});
