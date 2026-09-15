// The program the host runs instead of the sidecar when it wants edits to take effect.
//
// It used to be `bun --watch src/server.ts`, which re-read the source on every write. That is the
// right instinct and the wrong granularity: a write is not a change, it is a moment inside one, and
// the sidecar that re-read a half-written file threw during the reload and stayed ALIVE WITH ITS
// PORT FREE. Every stream the panel holds died at once, the panel kept rendering with nothing
// behind it, and the host's own port probe only gave up on it a minute later.
//
// So this owns the sidecar as a child process and hands it a tree only when a typechecker running
// in watch mode says the tree compiles. The typechecker is the watcher too: one opinion about the
// tree rather than two racing ones. `supervisorGate.ts` holds the decisions; this holds the
// processes.
//
// Everything it says goes to stdout, which the host writes to the sidecar's own log file, because
// `log show` answers nothing in this session and a supervisor whose reasoning is unreadable after
// the fact is indistinguishable from one that is not running.

import { createSupervisorGate } from "@/supervisorGate";

/** The sidecar itself, a sibling of this file: one argument for the host to get wrong, not two. */
const SERVER = new URL("./server.ts", import.meta.url).pathname;

/** This package, for the typechecker's working directory and its `node_modules`. */
const PACKAGE = new URL("../", import.meta.url).pathname;

/**
 * How long a green verdict waits before it is acted on.
 *
 * A verdict is about the tree as the run BEGAN, so a write landing mid-run is unjudged by it. tsc
 * starts another run for that write within its own debounce; this window is long enough to hear
 * that start and take the restart back, and short enough that nobody reads it as the reload being
 * broken.
 */
const RESTART_GRACE_MS = 400;

/** After a child that died on its own, so a crash loop does not spin the machine. */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000];

/** Long enough to count as "it ran", which is what resets the backoff. */
const SETTLED_MS = 10_000;

function say(message: string): void {
  console.log(`[sidecar-supervisor] ${message}`);
}

let child: ReturnType<typeof Bun.spawn> | undefined;
/** Set while a restart is deliberate, so the exit it causes is not read as a crash. */
let replacing = false;
let crashes = 0;
let pendingRestart: ReturnType<typeof setTimeout> | undefined;
let stopping = false;

function startSidecar(): void {
  const startedAt = Date.now();
  // stdio inherited: the host is already reading this process's output into the sidecar's log, and
  // a second copy through here would only add a layer that can drop lines.
  const spawned = Bun.spawn({
    cmd: [process.execPath, SERVER],
    stdio: ["ignore", "inherit", "inherit"],
  });
  child = spawned;
  say(`sidecar started, pid ${spawned.pid}`);

  void spawned.exited.then((code) => {
    if (child !== spawned) return;
    child = undefined;
    if (stopping) return;
    if (replacing) {
      replacing = false;
      startSidecar();
      return;
    }
    // Nobody asked for this. A sidecar that exits on its own has either crashed or been killed by
    // hand, and both want it back.
    if (Date.now() - startedAt > SETTLED_MS) crashes = 0;
    const wait = BACKOFF_MS[Math.min(crashes, BACKOFF_MS.length - 1)] ?? 10_000;
    crashes += 1;
    say(`sidecar exited with ${code}; starting it again in ${wait}ms`);
    setTimeout(() => {
      if (!stopping && !child) startSidecar();
    }, wait);
  });
}

function replaceSidecar(reason: string): void {
  if (!child) {
    say(`${reason}; nothing running, starting the sidecar`);
    startSidecar();
    return;
  }
  say(`${reason}; replacing the sidecar`);
  replacing = true;
  // SIGTERM rather than SIGKILL: the sidecar closes its listeners and lets go of the port, which is
  // what the next one needs in the half-second before it binds.
  child.kill();
}

const gate = createSupervisorGate({
  restart: (reason) => {
    clearTimeout(pendingRestart);
    pendingRestart = setTimeout(() => replaceSidecar(reason), RESTART_GRACE_MS);
  },
  abortRestart: () => clearTimeout(pendingRestart),
  log: say,
});

let typechecker: ReturnType<typeof Bun.spawn> | undefined;

function startTypechecker(attempt = 0): void {
  const checker = Bun.spawn({
    cmd: [
      `${PACKAGE}node_modules/.bin/tsc`,
      "--noEmit",
      "--watch",
      "--pretty",
      "false",
      // Without this tsc clears the screen every run, which in a log file is a screenful of escape
      // codes between every pair of useful lines.
      "--preserveWatchOutput",
    ],
    cwd: PACKAGE,
    stdio: ["ignore", "pipe", "inherit"],
  });
  typechecker = checker;

  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of checker.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split("\n");
      // The last piece may be half a line; tsc writes its errors and its verdict on separate ones.
      buffered = lines.pop() ?? "";
      for (const line of lines) gate.readTypecheckLine(line.trim());
    }
    if (stopping) return;
    // Losing the typechecker is losing the reload loop entirely, since it is also the watcher. So
    // it comes back rather than being worked around, and says so each time: a supervisor silently
    // running without one looks exactly like a tree nobody is editing.
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 10_000;
    say(`the typechecker exited; starting it again in ${wait}ms`);
    setTimeout(() => {
      if (!stopping) startTypechecker(attempt + 1);
    }, wait);
  })();

  return;
}

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  clearTimeout(pendingRestart);
  say(`${signal}; stopping the sidecar`);
  child?.kill();
  // Killed by name rather than left to the runtime: a typechecker outliving its supervisor watches
  // a tree nobody is acting on, and one per launch accumulates silently.
  typechecker?.kill();
  // The child holds the port, so leaving before it is gone hands the next launch a bound port. It
  // gets a moment, and the process leaves either way rather than hanging on a child that will not
  // go. A supervisor killed with SIGKILL cannot do even this, which is why `host-login` reclaims
  // the sidecar ports before it starts anything.
  setTimeout(() => process.exit(0), 2_000);
  void child?.exited.then(() => process.exit(0));
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGHUP", () => stop("SIGHUP"));

say(`supervising ${SERVER}`);
startSidecar();
startTypechecker();
