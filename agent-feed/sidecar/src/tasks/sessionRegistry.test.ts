import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRow } from "@/tasks/processProbe";
import { parseProcessLstart } from "@/tasks/processStartTime";
import { liveSessionProcesses, sessionOwner, readTmuxSession } from "@/tasks/sessionRegistry";

const SESSION = "2adc3708-fadb-4e2f-a744-322df224faf4";

/**
 * One row of the table `processTable` would return for a process started at `lstart`.
 *
 * The start time goes through the SAME `parseProcessLstart` the table parser uses, rather than a
 * literal: the reconciliation under test is between the registry's UTC `procStart` and the
 * kernel's local ctime, and a hardcoded number would assert the arithmetic instead of the parse.
 */
function row(pid: number, lstart: string): ProcessRow {
  return { pid, ppid: 1, startedAt: parseProcessLstart(lstart)!, cpuMs: 0, command: "claude" };
}

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
      "9672.json": {
        pid: 9672,
        sessionId: SESSION,
        cwd: "/Users/dev/projects/agent-desk",
        procStart,
        messagingSocketPath: "/tmp/cc-socks/9672.sock",
        entrypoint: "cli",
      },
    });
    expect(await liveSessionProcesses([row(9672, kernelStamp)], directory)).toEqual([
      {
        pid: 9672,
        sessionId: SESSION,
        cwd: "/Users/dev/projects/agent-desk",
        startedAt: Date.UTC(2026, 7, 14, 17, 10, 48),
        messagingSocketPath: "/tmp/cc-socks/9672.sock",
        entrypoint: "cli",
        tmuxSession: null,
        waiting: false,
        activity: null,
        version: null,
        name: null,
      },
    ]);
  });

  test("carries the row's status, version and name, and an unknown status as unknown", async () => {
    // The status is what a restart asks before replacing a process; the version is what says it
    // is behind the installed CLI. A status this reader does not know must not read as idle.
    const directory = await registryWith({
      "9672.json": { pid: 9672, sessionId: SESSION, cwd: "/x", procStart, status: "shell", version: "2.1.296", name: "Alan" },
      "9673.json": { pid: 9673, sessionId: `${SESSION.slice(0, -1)}1`, cwd: "/x", procStart, status: "napping" },
    });
    const live = await liveSessionProcesses([row(9672, kernelStamp), row(9673, kernelStamp)], directory);
    expect(live.map(({ pid, activity, version, name }) => ({ pid, activity, version, name }))
      .sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 9672, activity: "shell", version: "2.1.296", name: "Alan" },
      { pid: 9673, activity: null, version: null, name: null },
    ]);
  });

  test("reads a process blocked on its terminal from the row's status", async () => {
    // What the harness writes while a question dialog or a permission prompt stands in the pane.
    const directory = await registryWith({
      "9672.json": {
        pid: 9672,
        sessionId: SESSION,
        cwd: "/x",
        procStart,
        status: "waiting",
        waitingFor: "input needed",
      },
      "9673.json": { pid: 9673, sessionId: `${SESSION.slice(0, -1)}1`, cwd: "/x", procStart, status: "busy" },
    });
    const live = await liveSessionProcesses([row(9672, kernelStamp), row(9673, kernelStamp)], directory);
    expect(live.map((entry) => [entry.pid, entry.waiting]).sort()).toEqual([[9672, true], [9673, false]]);
  });

  test("a record with no inbox is live, just not writable", async () => {
    // An older harness, or one with the gate off. It still owns background shells, so refusing
    // the whole row over a missing socket would take task detection down with it.
    const directory = await registryWith({
      "9672.json": { pid: 9672, sessionId: SESSION, cwd: "/x", procStart, entrypoint: "claude-desktop" },
    });
    const [live] = await liveSessionProcesses([row(9672, kernelStamp)], directory);
    expect(live?.messagingSocketPath).toBeNull();
    expect(live?.entrypoint).toBe("claude-desktop");
  });

  test("an entrypoint we do not know reads as other rather than rejecting the row", async () => {
    const directory = await registryWith({
      "9672.json": { pid: 9672, sessionId: SESSION, cwd: "/x", procStart, entrypoint: "sdk-harness-9" },
    });
    expect((await liveSessionProcesses([row(9672, kernelStamp)], directory))[0]?.entrypoint)
      .toBe("other");
  });

  test("a dead pid is skipped, because stale records are the normal state of that directory", async () => {
    const directory = await registryWith({
      "9672.json": { pid: 9672, sessionId: SESSION, cwd: "/x", procStart },
    });
    // A pid that is gone has no row in the table at all.
    expect(await liveSessionProcesses([], directory)).toEqual([]);
  });

  test("a reused pid is refused, which is what procStart is for", async () => {
    const directory = await registryWith({
      "9672.json": { pid: 9672, sessionId: SESSION, cwd: "/x", procStart },
    });
    // Same pid, a process that started an hour later: some unrelated program now owns it.
    const later = await liveSessionProcesses([row(9672, "Fri Aug 14 18:10:48 2026")], directory);
    expect(later).toEqual([]);
  });

  test("a malformed record does not take the whole scan down", async () => {
    const directory = await registryWith({
      "9672.json": { pid: 9672, sessionId: SESSION, cwd: "/x", procStart },
      "bad.json": { nothing: true },
    });
    await writeFile(join(directory, "notjson.json"), "{{{");
    expect(await liveSessionProcesses([row(9672, kernelStamp)], directory)).toHaveLength(1);
  });

  test("a missing registry is an empty answer, not a throw", async () => {
    expect(await liveSessionProcesses([], "/nonexistent/agent-desk-test")).toEqual([]);
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
    expect(await sessionOwner(SESSION, [], directory)).toBeNull();
  });
});

test("keeps the tmux session name the harness writes, and only the name", () => {
  // The harness writes `<session>:@window.%pane` from 2.1.263. Every tmux verb this repo issues
  // addresses `-t <session>`, so the rest is noise -- and the value ends up on an argument vector,
  // so a row written by anything running as this user is validated rather than trusted.
  expect(readTmuxSession("keyboard:@4.%4")).toBe("keyboard");
  expect(readTmuxSession("rags")).toBe("rags");
  expect(readTmuxSession(undefined)).toBeNull();
  expect(readTmuxSession("")).toBeNull();
  for (const hostile of ["../etc:@0.%0", "a b:@0.%0", "-x:@0.%0", ";reboot"]) {
    expect(readTmuxSession(hostile)).toBeNull();
  }
});
