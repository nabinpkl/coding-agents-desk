// What `ps` says: parsing its fixed columns, unwrapping the shell wrapper a tool call
// runs behind, walking descendants, and taking one snapshot per tick.

import { beforeEach, describe, expect, test } from "bun:test";
import { config } from "../config.ts";
import {
  busiestDescendant,
  type CommandRunner,
  currentProcessTable,
  descendantsOf,
  matchShellsByCommand,
  parseCpuTime,
  parseProcessTable,
  type ProcessRow,
  resetProcessTableCache,
  shellDetailFrom,
  unwrapShellCommand,
} from "./processProbe.ts";

beforeEach(resetProcessTableCache);

// The harness's real wrapper, copied from `ps -o command=` on a live task shell rather than
// imagined. Everything before `eval` is preamble the viewer must never be shown.
const WRAPPER = "/bin/zsh -c source /Users/dev/.claude/shell-snapshots/snapshot-zsh-1786939825162-fgn1dk.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; \\builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'sleep 30 > /dev/null 2>&1' < /dev/null && pwd -P >| /tmp/claude-9b7a-cwd";

describe("unwrapShellCommand", () => {
  test("recovers the agent's command from the harness wrapper", () => {
    expect(unwrapShellCommand(WRAPPER)).toBe("sleep 30 > /dev/null 2>&1");
  });

  test("an interior quote survives the harness's splice, in the form it actually emits", () => {
    // Measured: the harness spells an embedded single quote `'"'"'`, and a live watcher's python
    // filter containing `line.startswith('{')` came back 88 characters longer than the transcript's
    // copy until this was handled -- so every comparison against that command failed silently.
    const argv = `/bin/zsh -c eval 'if not line.startswith('"'"'{'"'"'): continue' < /dev/null && pwd -P`;
    expect(unwrapShellCommand(argv)).toBe("if not line.startswith('{'): continue");
  });

  test("the other standard spelling of the same splice also works", () => {
    const argv = `/bin/zsh -c eval 'echo '\\''hi there'\\''' < /dev/null && pwd -P`;
    expect(unwrapShellCommand(argv)).toBe("echo 'hi there'");
  });

  test("a multi-line command keeps its newlines", () => {
    // `.` does not cross a newline without the s flag, and a heredoc or a for-loop is exactly the
    // kind of long command worth showing.
    const argv = "/bin/zsh -c eval 'for m in a b; do\n  echo $m\ndone' < /dev/null && pwd -P";
    expect(unwrapShellCommand(argv)).toBe("for m in a b; do\n  echo $m\ndone");
  });

  test("an unrecognised wrapper yields the whole argv rather than nothing", () => {
    // The wrapper is an undocumented harness artifact. When it moves, an ugly row beats a blank
    // one -- the viewer can still read what is running.
    expect(unwrapShellCommand("  /bin/zsh -c make all  ")).toBe("/bin/zsh -c make all");
  });
});

describe("parseCpuTime", () => {
  test("macOS minutes are unbounded, not rolled into hours", () => {
    // Real: a long-lived daemon reads `4318:19.61`. Treating the first field as hours would
    // report 4318 hours of CPU and make every activity line absurd.
    expect(parseCpuTime("4318:19.61")).toBe((4318 * 60 + 19.61) * 1000);
    expect(parseCpuTime("0:00.02")).toBe(20);
  });

  test("an hours field is tolerated in case the format grows one", () => {
    expect(parseCpuTime("1:02:03")).toBe((3600 + 123) * 1000);
  });

  test("garbage is null rather than NaN propagating into the wire", () => {
    expect(parseCpuTime("")).toBeNull();
    expect(parseCpuTime("-")).toBeNull();
    expect(parseCpuTime("1:2:3:4")).toBeNull();
  });
});

// Real `ps -eo pid=,ppid=,lstart=,time=,command=` shape, columns right-padded as ps pads them.
const TABLE = [
  "    1     0 Wed Jul 29 19:40:49 2026     283:15.55 /sbin/launchd",
  " 7680 38081 Mon Aug 17 01:02:03 2026       0:00.02 /bin/zsh -c eval 'node build.ts | tail -16' < /dev/null && pwd -P",
  " 7717  7680 Mon Aug 17 01:02:03 2026       0:00.01 /bin/zsh -c node build.ts",
  " 7718  7717 Mon Aug 17 01:02:04 2026       1:23.45 node build.ts",
  " 7719  7680 Mon Aug 17 01:02:03 2026       0:00.00 tail -16",
].join("\n");

describe("parseProcessTable", () => {
  test("splits the fixed leading fields and keeps the command whole", () => {
    const rows = parseProcessTable(TABLE);
    expect(rows).toHaveLength(5);
    expect(rows[3]).toEqual({
      pid: 7718,
      ppid: 7717,
      startedAt: new Date(2026, 7, 17, 1, 2, 4).getTime(),
      cpuMs: 83_450,
      command: "node build.ts",
    });
  });

  test("a task shell's argv is left wrapped here and unwrapped only where it is shown", () => {
    // The table is the raw kernel answer. Unwrapping belongs to the shell-detail lookup, so a
    // descendant's argv is never accidentally put through a wrapper stripper meant for shells.
    expect(parseProcessTable(TABLE)[1]?.command).toContain("eval 'node build.ts | tail -16'");
  });

  test("a truncated or headerless line is skipped rather than half-parsed", () => {
    expect(parseProcessTable("garbage\n  \n123 456 nope")).toEqual([]);
  });
});

describe("descendantsOf", () => {
  test("collects the whole tree, not just direct children", () => {
    const pids = descendantsOf(parseProcessTable(TABLE), 7680).map((row) => row.pid).sort();
    expect(pids).toEqual([7717, 7718, 7719]);
  });

  test("a leaf has no descendants and the walk terminates", () => {
    expect(descendantsOf(parseProcessTable(TABLE), 7719)).toEqual([]);
  });

  test("a self-parenting row cannot spin the walk forever", () => {
    // Not possible in a real table, but a pid reused between the ps snapshot and this walk could
    // fake one, and an unbounded loop inside a 2s poll does not recover.
    const rows = parseProcessTable(" 500   500 Mon Aug 17 01:02:03 2026       0:00.01 /bin/zsh");
    expect(descendantsOf(rows, 500)).toEqual([]);
  });
});

describe("busiestDescendant", () => {
  test("names the step doing the work, not the plumbing around it", () => {
    // The whole point: in `node build.ts | tail -16` the wrapper shell and `tail` sit at zero
    // while node climbs, so CPU picks node without needing to know which is which.
    expect(busiestDescendant(parseProcessTable(TABLE), 7680)?.command).toBe("node build.ts");
  });

  test("with no CPU burned anywhere, the most recent process wins", () => {
    // A pipeline of sleeps. Any of them is true; the newest is the one that just started.
    const rows = parseProcessTable([
      " 600   500 Mon Aug 17 01:02:03 2026       0:00.00 sleep 100",
      " 601   500 Mon Aug 17 01:02:09 2026       0:00.00 sleep 200",
    ].join("\n"));
    expect(busiestDescendant(rows, 500)?.pid).toBe(601);
  });

  test("a task with no descendants reports nothing rather than itself", () => {
    // Normal for a command that has just started, and final for one done in the shell itself.
    // Reporting the shell would show the viewer the harness's preamble as the current step.
    expect(busiestDescendant(parseProcessTable(TABLE), 7719)).toBeNull();
  });
});

describe("shellDetailFrom", () => {
  test("unwraps the harness preamble for a shell in the table", () => {
    expect(shellDetailFrom(parseProcessTable(TABLE), 7680)).toEqual({
      pid: 7680,
      startedAt: new Date(2026, 7, 17, 1, 2, 3).getTime(),
      command: "node build.ts | tail -16",
    });
  });

  test("a pid that exited between the lsof and the ps is null, not a guess", () => {
    expect(shellDetailFrom(parseProcessTable(TABLE), 99_999)).toBeNull();
  });

  test("a multi-line command comes back with its newlines and indentation", () => {
    // This is the command the panel SHOWS for a shell the transcript never named, so ps's octal
    // spelling has to be undone here too and not only where commands are compared. Left encoded,
    // the panel renders one unbroken line with a literal \012 standing where every newline and
    // indent belongs, which is exactly as unreadable as it sounds.
    const script = 'python3 -c "\nfor line in sys.stdin:\n    print(line)"';
    const rows = parseProcessTable(
      `700 500 Mon Aug 17 01:02:03 2026 0:00.01 /bin/zsh -c eval '${script.replaceAll("\n", "\\012")}' < /dev/null`,
    );
    expect(shellDetailFrom(rows, 700)?.command).toBe(script);
  });
});

describe("matchShellsByCommand", () => {
  const WATCH = 'tail -f /tmp/run20.log | python3 -u -c "\nimport json,sys\nprint(1)"';
  const ARGV = WATCH.replaceAll("\n", "\\012");
  const rows = (lines: string[]) => parseProcessTable(lines.join("\n"));

  test("sees through ps's octal escaping of a multi-line command", () => {
    // Without this the join never matches: a Monitor's command routinely embeds a script, and ps
    // renders every newline in it as a literal \012.
    const table = rows([`900 500 Mon Aug 17 01:02:03 2026 0:00.01 /bin/zsh -c eval '${ARGV}' < /dev/null`]);
    const matched = matchShellsByCommand(table, 500, [{ key: "m1", command: WATCH, startedAt: null }]);
    expect(matched.get("m1")?.pid).toBe(900);
  });

  test("only the named parent's children are candidates", () => {
    // Command alone is not identity across the machine: another session running the same watcher
    // would otherwise answer for this one.
    const table = rows([`900 999 Mon Aug 17 01:02:03 2026 0:00.01 /bin/zsh -c eval '${ARGV}' < /dev/null`]);
    expect(matchShellsByCommand(table, 500, [{ key: "m1", command: WATCH, startedAt: null }]).size)
      .toBe(0);
  });

  test("a shell is claimed once, and the closest start time wins it", () => {
    const table = rows([
      `900 500 Mon Aug 17 01:00:00 2026 0:00.01 /bin/zsh -c eval '${ARGV}' < /dev/null`,
      `901 500 Mon Aug 17 01:05:00 2026 0:00.01 /bin/zsh -c eval '${ARGV}' < /dev/null`,
    ]);
    const matched = matchShellsByCommand(table, 500, [
      { key: "new", command: WATCH, startedAt: new Date(2026, 7, 17, 1, 5, 0).getTime() },
      { key: "old", command: WATCH, startedAt: new Date(2026, 7, 17, 1, 0, 0).getTime() },
    ]);
    expect(matched.get("new")?.pid).toBe(901);
    expect(matched.get("old")?.pid).toBe(900);
  });

  test("no live shell running that command yields no entry, not a wrong one", () => {
    const table = rows([`900 500 Mon Aug 17 01:02:03 2026 0:00.01 /bin/zsh -c eval 'something else' < /dev/null`]);
    expect(matchShellsByCommand(table, 500, [{ key: "m1", command: WATCH, startedAt: null }]).size)
      .toBe(0);
  });
});

describe("currentProcessTable", () => {
  const ROW = "9672 1 Fri Aug 14 13:10:48 2026 0:00.00 claude";

  test("several probes in one tick share a single fork", async () => {
    let forks = 0;
    const run: CommandRunner = async () => {
      forks += 1;
      return ROW;
    };
    await currentProcessTable(run);
    await currentProcessTable(run);
    await currentProcessTable(run);
    // The whole point of the change: owner liveness, the session's children and the descendant
    // walk are three readings of one snapshot, and they used to be three trips to the kernel.
    expect(forks).toBe(1);
  });

  test("simultaneous askers share the fork that is already in flight", async () => {
    // Subscribers tick together. Waiting only on the CACHE would let every one of them start its
    // own `ps` before the first had returned, which is the cost this exists to remove.
    let forks = 0;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run: CommandRunner = async () => {
      forks += 1;
      await gate;
      return ROW;
    };
    const all = Promise.all([currentProcessTable(run), currentProcessTable(run), currentProcessTable(run)]);
    release();
    const tables = await all;
    expect(forks).toBe(1);
    for (const table of tables) expect(table).toHaveLength(1);
  });

  test("a table older than the window is refetched", async () => {
    let forks = 0;
    const run: CommandRunner = async () => {
      forks += 1;
      return ROW;
    };
    let clock = 1_000_000;
    const now = () => clock;
    await currentProcessTable(run, now);
    clock += config.backgroundTaskPollMs;
    await currentProcessTable(run, now);
    expect(forks).toBe(2);
  });

  test("a failed fork is not cached, so the next tick tries again", async () => {
    // `runCommand` answers "" for a tool that would not run. Caching that would report an empty
    // machine for as long as the window lasts, and every consumer reads an absent row as a dead
    // process -- the silent shape this module keeps paying for.
    let forks = 0;
    const run: CommandRunner = async () => {
      forks += 1;
      throw new Error("ps could not be spawned");
    };
    await expect(currentProcessTable(run)).rejects.toThrow("ps could not be spawned");
    await expect(currentProcessTable(run)).rejects.toThrow("ps could not be spawned");
    expect(forks).toBe(2);
  });
});
