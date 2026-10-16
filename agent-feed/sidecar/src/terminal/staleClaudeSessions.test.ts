import { expect, test } from "bun:test";
import type { ClaudeSessionActivity } from "@agentdesk/agent-feed-wire";
import type { ProcessRow } from "@/tasks/processTable";
import type { ClaudeSessionProcess } from "@/tasks/sessionRegistry";
import {
  launchedWithFlags,
  listStaleSessions,
  paneLaunchArguments,
  panelLaunched,
  restartStaleSessions,
  sessionActivity,
  type StaleSessionSources,
} from "@/terminal/staleClaudeSessions";

const FLAGS = ["--permission-mode", "auto", "--allow-dangerously-skip-permissions"];
const CURRENT = `claude ${FLAGS.join(" ")} --resume`;

function processOf(
  pid: number,
  sessionId: string,
  { activity = "idle", version = "2.1.301", tmuxSession = "pane" }: {
    activity?: ClaudeSessionActivity | null;
    version?: string | null;
    tmuxSession?: string | null;
  } = {},
): ClaudeSessionProcess {
  return {
    pid,
    sessionId,
    cwd: "/repo",
    startedAt: 0,
    messagingSocketPath: null,
    entrypoint: "cli",
    tmuxSession,
    waiting: activity === "waiting",
    activity,
    version,
    name: `Session ${sessionId}`,
  };
}

function rowOf(pid: number, command: string): ProcessRow {
  return { pid, ppid: 1, startedAt: 0, cpuMs: 0, command };
}

/** A machine whose registry and kernel can be changed between reads, the way a live one changes. */
function machine(
  processes: ClaudeSessionProcess[],
  commands: Record<number, string>,
  { notOurs = [] as string[], starts = {} as Record<string, string> } = {},
) {
  const state = { processes, commands };
  const sources: StaleSessionSources = {
    async processes() {
      return {
        table: Object.entries(state.commands).map(([pid, command]) => rowOf(Number(pid), command)),
        live: state.processes,
      };
    },
    installedVersion: () => "2.1.301",
    launchArgs: FLAGS,
    launchedPane: async (sessionId) =>
      notOurs.includes(sessionId) ? null : starts[sessionId] ?? `claude --resume ${sessionId}`,
  };
  return { state, sources };
}

test("a command carries the launch flags in any order, a flag's value beside it", () => {
  expect(launchedWithFlags(`${CURRENT} abc`, FLAGS)).toBe(true);
  expect(launchedWithFlags("claude --allow-dangerously-skip-permissions --permission-mode auto -r x", FLAGS)).toBe(true);
  expect(launchedWithFlags("claude --resume abc", FLAGS)).toBe(false);
  // The flag present with another value is a different launch, not the current one.
  expect(launchedWithFlags("claude --permission-mode plan --allow-dangerously-skip-permissions", FLAGS)).toBe(false);
});

// Start commands as `tmux list-panes -F '#{pane_start_command}'` printed them on 2026-10-16.
const PANEL_FIRST_TURN = String.raw`"/bin/zsh -l -c ''\\''/bin/sh'\\'' '\\''-c'\\'' '\\''f=$1; shift'\\'' '\\''agentdesk-first-turn'\\'' '\\''/T/turn.txt'\\'' '\\''claude'\\'' '\\''--permission-mode'\\'' '\\''auto'\\'' '\\''--allow-dangerously-skip-permissions'\\'' '\\''--session-id'\\'' '\\''00f3'\\'' '\\''-n'\\'' '\\''Dean (handover)'\\''; exec /bin/zsh -l'"`;
const ARENA = String.raw`"/bin/zsh -l -c 'export PATH=/x; '\\''/u/.local/bin/claude'\\'' '\\''--session-id'\\'' '\\''f697'\\'' '\\''-n'\\'' '\\''arena manager dc525436'\\'' '\\''--disallowedTools'\\'' '\\''Edit,Write'\\''; exec /bin/zsh -l'"`;
const PROBE = "claude --model claude-haiku --effort low --session-id 508a -n scrollprobe --strict-mcp-config --tools Read";

test("a pane's launch arguments come out whole, each as the sidecar quoted it", () => {
  expect(paneLaunchArguments(ARENA)).toEqual([
    "/u/.local/bin/claude", "--session-id", "f697", "-n", "arena manager dc525436", "--disallowedTools", "Edit,Write",
  ]);
  // A pane started by hand has no quoting, and splits on whitespace.
  expect(paneLaunchArguments(PROBE)).toContain("--tools");
  // A hand-typed pane reads the command that runs claude, not the shell it falls back to after.
  expect(paneLaunchArguments('"X=1 claude --session-id a -n \'Stale probe\'; exec /bin/zsh -l"'))
    .toEqual(["claude", "--session-id", "a", "-n", "Stale", "probe"]);
  // And a flag before it in the same command is still read.
  expect(paneLaunchArguments("export X=1; claude --model y")).toEqual(["claude", "--model", "y"]);
  // Stray quoting on a hand-typed command does not hide a flag.
  expect(paneLaunchArguments(`"claude '--model' x"`)).toEqual(["claude", "--model", "x"]);
});

test("a launch of its own is any flag the sidecar's launches do not use", () => {
  expect(panelLaunched(paneLaunchArguments(PANEL_FIRST_TURN), FLAGS)).toBe(true);
  expect(panelLaunched(["claude", "--resume", "abc"], FLAGS)).toBe(true);
  expect(panelLaunched(paneLaunchArguments(ARENA), FLAGS)).toBe(false);
  expect(panelLaunched(paneLaunchArguments(PROBE), FLAGS)).toBe(false);
});

test("a session with several processes is as active as its most active one, and unknown beats idle", () => {
  expect(sessionActivity([processOf(1, "a"), processOf(2, "a", { activity: "busy" })])).toBe("busy");
  expect(sessionActivity([processOf(1, "a"), processOf(2, "a", { activity: "shell" })])).toBe("shell");
  expect(sessionActivity([processOf(1, "a", { activity: null }), processOf(2, "a")])).toBeNull();
});

test("lists sessions behind the flags or the installed CLI, and only panes this sidecar launched", async () => {
  const { sources } = machine(
    [
      processOf(1, "old-flags"),
      processOf(2, "old-version", { version: "2.1.296" }),
      processOf(3, "current"),
      processOf(4, "someone-elses", { version: "2.1.285" }),
      processOf(5, "desktop-window", { version: "2.1.285", tmuxSession: null }),
    ],
    { 1: "claude --resume old-flags", 2: `${CURRENT} old-version`, 3: `${CURRENT} current`, 4: "claude", 5: "claude" },
    { notOurs: ["someone-elses"] },
  );
  const stale = await listStaleSessions(sources);
  expect(stale.installedVersion).toBe("2.1.301");
  expect(stale.sessions.map(({ sessionId, reasons, activity }) => ({ sessionId, reasons, activity }))).toEqual([
    { sessionId: "old-flags", reasons: ["launch-flags"], activity: "idle" },
    { sessionId: "old-version", reasons: ["update"], activity: "idle" },
  ]);
});

test("a session started with flags of its own is listed as such, and never restarted", async () => {
  const { sources } = machine([processOf(1, "probe")], { 1: PROBE }, { starts: { probe: PROBE } });
  const stale = await listStaleSessions(sources);
  expect(stale.sessions.map(({ sessionId, ownLaunch }) => ({ sessionId, ownLaunch })))
    .toEqual([{ sessionId: "probe", ownLaunch: true }]);
  const restarted: string[] = [];
  const [result] = await restartStaleSessions(["probe"], { ...sources, restart: async (id) => { restarted.push(id); } });
  expect(restarted).toEqual([]);
  expect(result?.outcome).toEqual({ kind: "skipped", reason: "launched with flags of its own, which a restart would drop" });
});

test("an install that does not say its version flags nothing as an update", async () => {
  const { sources } = machine([processOf(1, "a", { version: "2.1.200" })], { 1: `${CURRENT} a` });
  const stale = await listStaleSessions({ ...sources, installedVersion: () => null });
  expect(stale).toEqual({ installedVersion: null, sessions: [] });
});

test("restarts only idle sessions, and says why each of the others was left running", async () => {
  const { sources } = machine(
    [
      processOf(1, "idle"),
      processOf(2, "busy", { activity: "busy" }),
      processOf(3, "shell", { activity: "shell" }),
      processOf(4, "waiting", { activity: "waiting" }),
    ],
    { 1: "claude", 2: "claude", 3: "claude", 4: "claude" },
  );
  const restarted: string[] = [];
  const results = await restartStaleSessions(["idle", "busy", "shell", "waiting"], {
    ...sources,
    restart: async (sessionId) => {
      restarted.push(sessionId);
    },
  });
  expect(restarted).toEqual(["idle"]);
  expect(results.map(({ sessionId, outcome }) => [sessionId, outcome])).toEqual([
    ["idle", { kind: "restarted" }],
    ["busy", { kind: "skipped", reason: "a turn is running" }],
    ["shell", { kind: "skipped", reason: "a background shell is running" }],
    ["waiting", { kind: "skipped", reason: "a dialog is open" }],
  ]);
});

test("a session judged as it stands at its restart, not as the reader saw it", async () => {
  const { state, sources } = machine(
    [processOf(1, "went-busy"), processOf(2, "now-current"), processOf(3, "stays")],
    { 1: "claude", 2: "claude", 3: "claude" },
  );
  // Between the list the reader saw and the restart: one session took a turn, one was restarted
  // by hand onto the current flags.
  state.commands = { 1: "claude", 2: `${CURRENT} now-current`, 3: "claude" };
  let reads = 0;
  const results = await restartStaleSessions(["went-busy", "now-current", "stays", "never-listed"], {
    ...sources,
    async processes() {
      reads += 1;
      const read = await sources.processes();
      // The first read is the fresh list; every later one is the check just before a restart.
      return reads === 1 ? read : { ...read, live: read.live.map((p) => p.sessionId === "went-busy" ? { ...p, activity: "busy" } : p) };
    },
    restart: async () => {},
  });
  expect(results.map(({ sessionId, outcome }) => [sessionId, outcome.kind])).toEqual([
    ["went-busy", "skipped"],
    ["now-current", "skipped"],
    ["stays", "restarted"],
    ["never-listed", "skipped"],
  ]);
});

test("one failed restart is reported and does not stop the rest", async () => {
  const { sources } = machine([processOf(1, "a"), processOf(2, "b"), processOf(3, "c")], { 1: "claude", 2: "claude", 3: "claude" });
  const results = await restartStaleSessions(["a", "b", "c"], {
    ...sources,
    restart: async (sessionId) => {
      if (sessionId === "b") throw new Error("tmux went away");
    },
  });
  expect(results.map(({ outcome }) => outcome)).toEqual([
    { kind: "restarted" },
    { kind: "failed", message: "tmux went away" },
    { kind: "restarted" },
  ]);
});

test("no more than three restarts run at once", async () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  const { sources } = machine(ids.map((id, index) => processOf(index + 1, id)), Object.fromEntries(ids.map((_, index) => [index + 1, "claude"])));
  let running = 0;
  let most = 0;
  await restartStaleSessions(ids, {
    ...sources,
    restart: async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
    },
  });
  expect(most).toBe(3);
});
