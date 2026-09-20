// The program the host runs instead of the sidecar when it wants edits to take effect.
//
// It used to be `bun --watch src/server.ts`, which re-read the source on every write. That is the
// right instinct and the wrong granularity: a write is not a change, it is a moment inside one, and
// the sidecar that re-read a half-written file threw during the reload and stayed ALIVE WITH ITS
// PORT FREE. Every stream the panel holds died at once, the panel kept rendering with nothing
// behind it, and the host's own port probe only gave up on it a minute later.
//
// So this owns the sidecar as a child process, watches the tree itself, and replaces the child only
// once every file that changed is a whole file. `supervisorGate.ts` holds the decisions; this holds
// the processes, the watcher and the parser.
//
// Everything it says goes to stdout, which the host writes to the sidecar's own log file, because
// `log show` answers nothing in this session and a supervisor whose reasoning is unreadable after
// the fact is indistinguishable from one that is not running. It also heartbeats its state onto the
// same rendezvous board the sidecar announces itself on, so the panel can show a held sidecar
// instead of the reader seeing a feed that has merely gone quiet.

import { dirname } from "node:path";
import chokidar from "chokidar";
import {
  clearSupervisorDescriptor,
  clearSupervisorRequest,
  readSupervisorRequest,
  writeSupervisorDescriptor,
} from "@/sidecarRegistry";
import { createSupervisorGate, type ParsedChange, type SupervisorState } from "@/supervisorGate";

/** The sidecar itself, a sibling of this file: one argument for the host to get wrong, not two. */
const SERVER = new URL("./server.ts", import.meta.url).pathname;

/** The tree this watches, which is everything the sidecar can import. */
const SOURCE = dirname(SERVER);

/**
 * How long writes are collected before anything is decided about them.
 *
 * An editor writing a file produces more than one event, and a tool rewriting several files
 * produces one burst; restarting per event would restart into each intermediate tree in turn.
 *
 * Overridable because the writer is not always an editor. A peer's tree arrives by rsync
 * (`tools/remote-sidecar.sh`), which lands each file as it transfers, so a ship of several files
 * is one change spread over as long as the link takes. Waiting 200ms there would replace the
 * sidecar once per file on the way to the tree somebody actually meant to send.
 */
const SETTLE_MS = Math.max(
  50,
  Number(process.env.AGENT_FEED_SUPERVISOR_SETTLE_MS) || 200,
);

/** After a child that died on its own, so a crash loop does not spin the machine. */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000];

/** Long enough to count as "it ran", which is what resets the backoff. */
const SETTLED_MS = 10_000;

/** Matches the sidecar board's own heartbeat, and the panel ages this out at three misses. */
const HEARTBEAT_MS = 5_000;

/**
 * How often the panel's standing request is re-read.
 *
 * A poll rather than a watcher, for two reasons. Under Bun every SECOND `fs.watch` on a path is
 * inert, and this process already owns one on its source tree, so a second is a coin flip. And the
 * file is a few bytes on local disk: a read a second is not a cost worth engineering around, while
 * a second of lag on a button press is the most it can ever be.
 */
const REQUEST_POLL_MS = 1_000;

function say(message: string): void {
  console.log(`[sidecar-supervisor] ${message}`);
}

// ---------------------------------------------------------------------------
// The board the panel reads
//
// Written rather than served, because this process serves nothing: the sidecar is the thing with a
// port, and it reads this back to answer `/api/config`. That is what carries a held sidecar to a
// panel on ANOTHER machine, which cannot see this file at all.

let published: SupervisorState = { held: false, blocked: null, mode: "auto" };

function publish(state: SupervisorState = published): void {
  published = state;
  try {
    writeSupervisorDescriptor(state);
  } catch (error) {
    // The panel loses one row of detail; the dev loop is unaffected, so this is not worth dying for.
    say(`could not publish state: ${String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// The sidecar process

let child: ReturnType<typeof Bun.spawn> | undefined;
/** Set while a restart is deliberate, so the exit it causes is not read as a crash. */
let replacing = false;
let crashes = 0;
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
  restart: replaceSidecar,
  log: say,
  publish,
});

// ---------------------------------------------------------------------------
// What the reader asked for
//
// The panel cannot call this process -- it has no port, and the panel is often on another machine
// -- so it leaves the request with the sidecar, which writes it onto the same board this publishes
// state to. Read here on a timer and handed to the gate, which is the only thing that decides.

/** The last `apply` acted on, so a standing request is not re-applied every time it is read. */
let appliedAt = 0;

function readRequest(): void {
  const request = readSupervisorRequest();
  gate.setMode(request.mode);
  if (request.apply <= appliedAt) return;
  appliedAt = request.apply;
  if (!gate.apply()) say("asked to take the tree, and there is nothing to take or it will not parse");
}

// ---------------------------------------------------------------------------
// Watching, and reading whether a file is whole

/**
 * Bun's own transpiler, which is the thing that will actually read these files a moment later.
 *
 * In process and about a millisecond per file, so the gate costs no resident memory at all. A
 * `.tsx` loader parses plain `.ts` too, so one instance covers the tree.
 */
const transpiler = new Bun.Transpiler({ loader: "tsx" });

async function parsed(path: string): Promise<ParsedChange> {
  const file = Bun.file(path);
  // A file that is gone is a change, not a broken file: there is nothing left to parse, and holding
  // the tree on it would mean a deletion could never be picked up at all.
  if (!(await file.exists())) return { path, failure: null };
  try {
    transpiler.transformSync(await file.text());
    return { path, failure: null };
  } catch (error) {
    return { path, failure: String((error as Error).message).split("\n")[0] ?? "will not parse" };
  }
}

/** Collected between decisions, so one burst of writes is judged as one change. */
const pending = new Set<string>();
let settle: ReturnType<typeof setTimeout> | undefined;

function noteChange(path: string): void {
  if (!/\.tsx?$/.test(path) || path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return;
  pending.add(path);
  clearTimeout(settle);
  settle = setTimeout(() => {
    const batch = [...pending];
    pending.clear();
    void Promise.all(batch.map(parsed)).then((changes) => gate.changed(changes));
  }, SETTLE_MS);
}

function startWatching(): void {
  // One watcher for the process, created once and never closed. Under Bun every SECOND `fs.watch`
  // on a path is inert (measured on 1.3.13: six open/close cycles delivered 3, 0, 3, 0, 3, 0
  // events), so a watcher that comes and goes silently stops working the second time.
  const watcher = chokidar.watch(SOURCE, { ignoreInitial: true });
  watcher.on("add", noteChange);
  watcher.on("change", noteChange);
  watcher.on("unlink", noteChange);
  watcher.on("error", (error) => say(`watcher error: ${String(error)}`));
  say(`watching ${SOURCE}`);
}

// ---------------------------------------------------------------------------

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  clearTimeout(settle);
  clearInterval(requests);
  say(`${signal}; stopping the sidecar`);
  child?.kill();
  clearSupervisorDescriptor();
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
// A fresh supervisor is a fresh decision. Whatever a panel asked of the last one is forgotten here,
// so a request left over from yesterday cannot silently freeze this machine's sidecar.
clearSupervisorRequest();
publish();
const heartbeat = setInterval(() => publish(), HEARTBEAT_MS);
heartbeat.unref?.();
const requests = setInterval(readRequest, REQUEST_POLL_MS);
requests.unref?.();
startSidecar();
startWatching();
