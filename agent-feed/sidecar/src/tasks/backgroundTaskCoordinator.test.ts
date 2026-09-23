import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackgroundTaskSnapshot } from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import { createBackgroundTaskCoordinator } from "@/tasks/backgroundTaskCoordinator";
import { type CommandRunner, resetProcessTableCache } from "@/tasks/processProbe";

// The shared table is cached for a window, so without this one test's kernel answers the next.
beforeEach(resetProcessTableCache);

const ONE = "2adc3708-fadb-4e2f-a744-322df224faf4";
const TWO = "0b1d4f6c-8a2e-4c19-9f77-2b6d3e5a1c04";
const CAPTURE_ONE = `${config.claudeTaskRoot}/-private-tmp/${ONE}/tasks/bukxtjy7e.output`;
const CAPTURE_TWO = `${config.claudeTaskRoot}/-private-tmp/${TWO}/tasks/bother999.output`;

/**
 * The ctime string the kernel prints locally for the instant the registry records in UTC.
 * Built rather than written down so these hold in any timezone.
 */
const KERNEL_STAMP = (() => {
  const at = new Date(Date.UTC(2026, 7, 14, 17, 10, 48));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${days[at.getDay()]} ${months[at.getMonth()]} ${String(at.getDate()).padStart(2, " ")} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())} ${at.getFullYear()}`;
})();
const PROC_START = "Fri Aug 14 17:10:48 2026";

/** A registry holding a live process for each of `sessions`, keyed session id to pid. */
async function registryWith(sessions: ReadonlyMap<string, number>): Promise<string> {
  const directory = await mkdtemp(join("/tmp", "adz-tasks-"));
  for (const [sessionId, pid] of sessions) {
    await writeFile(
      join(directory, `${pid}.json`),
      JSON.stringify({ pid, sessionId, cwd: "/x", procStart: PROC_START, entrypoint: "cli" }),
    );
  }
  return directory;
}

/**
 * A machine where each owner pid has one task shell holding its capture open.
 *
 * Every process started in the past, so a shell is far older than the uncorroborated threshold and
 * appears without needing a transcript -- these tests are about who gets told what, not about the
 * transcript join, which `assembleSnapshot`'s own tests cover.
 */
function machine(owners: ReadonlyMap<number, { shellPid: number; capture: string }>) {
  const rows = [...owners].map(([ownerPid, { shellPid }]) =>
    `${shellPid} ${ownerPid} ${KERNEL_STAMP} 0:00.00 zsh`
  );
  const psRows = [...owners.keys()].map((pid) => `${pid} 1 ${KERNEL_STAMP} 0:00.00 claude`);
  const lsof = [...owners.values()]
    .map(({ shellPid, capture }) => `p${shellPid}\nf1\naw\nn${capture}\n`)
    .join("");
  return { table: [...psRows, ...rows].join("\n"), lsof };
}

describe("createBackgroundTaskCoordinator", () => {
  /**
   * Waits out the pass `subscribe` kicks off, and the one queued behind it.
   *
   * Subscribing asks for a refresh, and a subscriber arriving mid-pass queues a follow-up, so a
   * test that counts forks has to start from a coordinator that is not mid-anything.
   */
  const drain = async (coordinator: { refresh: () => Promise<void> }): Promise<void> => {
    await coordinator.refresh();
    await coordinator.refresh();
  };

  test("one kernel pass answers every watched session", async () => {
    // The whole point. Two sessions used to mean two process tables, two registry passes and two
    // lsof forks per tick; they are one question asked of one kernel.
    const directory = await registryWith(new Map([[ONE, 9672], [TWO, 9673]]));
    const { table, lsof } = machine(new Map([
      [9672, { shellPid: 63854, capture: CAPTURE_ONE }],
      [9673, { shellPid: 71001, capture: CAPTURE_TWO }],
    ]));
    let forks: string[] = [];
    const run: CommandRunner = async (argv) => {
      forks.push(argv[0]!);
      return argv[0] === "/bin/ps" ? table : lsof;
    };
    const coordinator = createBackgroundTaskCoordinator({ run, sessionsDirectory: directory });

    const seen = new Map<string, BackgroundTaskSnapshot>();
    const stopOne = coordinator.subscribe(ONE, (snapshot) => seen.set(ONE, snapshot));
    const stopTwo = coordinator.subscribe(TWO, (snapshot) => seen.set(TWO, snapshot));
    await drain(coordinator);
    expect(seen.get(ONE)?.running.map((task) => task.taskId)).toEqual(["bukxtjy7e"]);
    expect(seen.get(TWO)?.running.map((task) => task.taskId)).toEqual(["bother999"]);

    // Counted over a pass of its own, from a cold table, so the subscribe-time passes above cannot
    // be mistaken for the per-tick cost.
    forks = [];
    resetProcessTableCache();
    await coordinator.refresh();
    expect(forks.filter((binary) => binary === "/bin/ps")).toHaveLength(1);
    expect(forks.filter((binary) => binary === "/usr/sbin/lsof")).toHaveLength(1);
    stopOne();
    stopTwo();
  });

  test("a session subscribing during a pass is still probed by the refresh it asked for", async () => {
    // The running pass read its session list before this session existed. Joining it would resolve
    // having never asked about the session that prompted the call, and the card would sit blank
    // until the next tick.
    const directory = await registryWith(new Map([[ONE, 9672], [TWO, 9673]]));
    const { table, lsof } = machine(new Map([
      [9672, { shellPid: 63854, capture: CAPTURE_ONE }],
      [9673, { shellPid: 71001, capture: CAPTURE_TWO }],
    ]));
    const run: CommandRunner = async (argv) => (argv[0] === "/bin/ps" ? table : lsof);
    const coordinator = createBackgroundTaskCoordinator({ run, sessionsDirectory: directory });

    const stopOne = coordinator.subscribe(ONE, () => {});
    let late: BackgroundTaskSnapshot | null = null;
    const stopTwo = coordinator.subscribe(TWO, (snapshot) => { late = snapshot; });
    await coordinator.refresh();
    expect(late).not.toBeNull();
    expect(late!.running.map((task) => task.taskId)).toEqual(["bother999"]);
    stopOne();
    stopTwo();
  });

  test("each session is told only about its own tasks", async () => {
    // One lsof answer covers everybody, so mis-grouping it would show one session another's work.
    const directory = await registryWith(new Map([[ONE, 9672], [TWO, 9673]]));
    const { table, lsof } = machine(new Map([
      [9672, { shellPid: 63854, capture: CAPTURE_ONE }],
      [9673, { shellPid: 71001, capture: CAPTURE_TWO }],
    ]));
    const run: CommandRunner = async (argv) => (argv[0] === "/bin/ps" ? table : lsof);
    const coordinator = createBackgroundTaskCoordinator({ run, sessionsDirectory: directory });
    let onlyOne: BackgroundTaskSnapshot | null = null;
    const stop = coordinator.subscribe(ONE, (snapshot) => { onlyOne = snapshot; });
    await coordinator.refresh();
    expect(onlyOne!.running.map((task) => task.taskId)).toEqual(["bukxtjy7e"]);
    stop();
  });

  test("an unchanged snapshot is not resent, and a changed one is", async () => {
    const directory = await registryWith(new Map([[ONE, 9672]]));
    const busy = machine(new Map([[9672, { shellPid: 63854, capture: CAPTURE_ONE }]]));
    let lsofAnswer = busy.lsof;
    const run: CommandRunner = async (argv) => (argv[0] === "/bin/ps" ? busy.table : lsofAnswer);
    const coordinator = createBackgroundTaskCoordinator({ run, sessionsDirectory: directory });

    const sent: BackgroundTaskSnapshot[] = [];
    const stop = coordinator.subscribe(ONE, (snapshot) => sent.push(snapshot));
    await coordinator.refresh();
    resetProcessTableCache();
    await coordinator.refresh();
    expect(sent).toHaveLength(1);

    // The task ended: its shell no longer holds the capture.
    lsofAnswer = "";
    resetProcessTableCache();
    await coordinator.refresh();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.running).toEqual([]);
    stop();
  });

  test("a second panel on a watched session paints from the current snapshot at once", async () => {
    // Suppression is per session, not per listener, so a late joiner would otherwise sit blank
    // until something about that session changed -- which for a long task is never.
    const directory = await registryWith(new Map([[ONE, 9672]]));
    const { table, lsof } = machine(new Map([[9672, { shellPid: 63854, capture: CAPTURE_ONE }]]));
    const run: CommandRunner = async (argv) => (argv[0] === "/bin/ps" ? table : lsof);
    const coordinator = createBackgroundTaskCoordinator({ run, sessionsDirectory: directory });

    const stopFirst = coordinator.subscribe(ONE, () => {});
    await coordinator.refresh();
    let late: BackgroundTaskSnapshot | null = null;
    const stopLate = coordinator.subscribe(ONE, (snapshot) => { late = snapshot; });
    expect(late!.running.map((task) => task.taskId)).toEqual(["bukxtjy7e"]);
    stopFirst();
    stopLate();
  });

  test("the last watcher leaving drops the snapshot, so a rejoin is not handed a stale one", async () => {
    const directory = await registryWith(new Map([[ONE, 9672]]));
    const { table, lsof } = machine(new Map([[9672, { shellPid: 63854, capture: CAPTURE_ONE }]]));
    const run: CommandRunner = async (argv) => (argv[0] === "/bin/ps" ? table : lsof);
    const coordinator = createBackgroundTaskCoordinator({ run, sessionsDirectory: directory });

    const stop = coordinator.subscribe(ONE, () => {});
    await coordinator.refresh();
    stop();

    let handed: BackgroundTaskSnapshot | null = null;
    const stopAgain = coordinator.subscribe(ONE, (snapshot) => { handed = snapshot; });
    // Nothing delivered synchronously: the reading from before it left is minutes old as far as
    // this subscriber knows, and a fresh pass is already on its way.
    expect(handed).toBeNull();
    stopAgain();
  });

  test("a failed kernel pass leaves the last snapshot standing rather than erasing it", async () => {
    // A fork that could not run is not evidence that a session has no tasks. Publishing empty here
    // would blank a live task list because `ps` was briefly unavailable.
    const directory = await registryWith(new Map([[ONE, 9672]]));
    const { table, lsof } = machine(new Map([[9672, { shellPid: 63854, capture: CAPTURE_ONE }]]));
    let failing = false;
    const run: CommandRunner = async (argv) => {
      if (failing) throw new Error("ps could not be spawned");
      return argv[0] === "/bin/ps" ? table : lsof;
    };
    const coordinator = createBackgroundTaskCoordinator({ run, sessionsDirectory: directory });

    const sent: BackgroundTaskSnapshot[] = [];
    const stop = coordinator.subscribe(ONE, (snapshot) => sent.push(snapshot));
    await coordinator.refresh();
    expect(sent).toHaveLength(1);

    failing = true;
    resetProcessTableCache();
    await coordinator.refresh();
    expect(sent).toHaveLength(1);
    stop();
  });

  test("nothing is asked of the kernel while nobody is watching", async () => {
    const directory = await registryWith(new Map([[ONE, 9672]]));
    let calls = 0;
    const run: CommandRunner = async () => {
      calls += 1;
      return "";
    };
    const coordinator = createBackgroundTaskCoordinator({ run, sessionsDirectory: directory });
    await coordinator.refresh();
    expect(calls).toBe(0);
  });

  test("callers arriving together are served by one follow-up pass, not one each", async () => {
    const directory = await registryWith(new Map([[ONE, 9672]]));
    const { table, lsof } = machine(new Map([[9672, { shellPid: 63854, capture: CAPTURE_ONE }]]));
    let tables = 0;
    const run: CommandRunner = async (argv) => {
      if (argv[0] === "/bin/ps") {
        tables += 1;
        return table;
      }
      return lsof;
    };
    const coordinator = createBackgroundTaskCoordinator({ run, sessionsDirectory: directory });
    const stop = coordinator.subscribe(ONE, () => {});
    await drain(coordinator);
    resetProcessTableCache();
    tables = 0;
    // One pass runs and three callers arrive; they share a single follow-up rather than stacking
    // one pass each on top of it.
    await Promise.all([coordinator.refresh(), coordinator.refresh(), coordinator.refresh()]);
    expect(tables).toBeLessThanOrEqual(2);
    stop();
  });
});
