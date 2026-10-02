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
import { ownSources } from "@/supervisorSources";
import { stopChild } from "@/supervisorStop";

/** The sidecar itself, a sibling of this file: one argument for the host to get wrong, not two. */
const SERVER = new URL("./server.ts", import.meta.url).pathname;

/** The tree this watches, which is everything the sidecar can import. */
const SOURCE = dirname(SERVER);

/**
 * The files THIS process is built from, which are in that tree too.
 *
 * The one thing it cannot fix by replacing the child. A change to the rule for when to restart used
 * to sit here running the old rule and looking exactly like the new one until somebody relaunched
 * the host, which is the worst kind of stale: the code most likely to be wrong about whether it is
 * current is the code that decides it.
 */
const OWN = ownSources(new URL(import.meta.url).pathname, SOURCE);

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

/**
 * What taking the tree means, which depends on whose code moved.
 *
 * Reached only once the gate has decided the tree is worth taking, so the parse rule and the
 * reader's mode both still apply: a supervisor's own half-written file holds everything back
 * exactly like the sidecar's does.
 */
function takeTheTree(reason: string): void {
  if (!selfStale) {
    replaceSidecar(reason);
    return;
  }
  leave(`${reason}; one of them is this supervisor's own, so it is leaving for a newer one`);
}

function replaceSidecar(reason: string): void {
  if (!child) {
    say(`${reason}; nothing running, starting the sidecar`);
    startSidecar();
    return;
  }
  say(`${reason}; replacing the sidecar`);
  replacing = true;
  // SIGTERM first: the sidecar closes its listeners and lets go of the port, which is what the next
  // one needs in the half-second before it binds. SIGKILL only if it cannot, or the replacement
  // would wait on its exit forever.
  stopChild(child, say);
}

const gate = createSupervisorGate({
  restart: takeTheTree,
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

/** Set once a file this process is built from has moved, and cleared only by leaving. */
let selfStale = false;

function noteChange(path: string): void {
  if (!/\.tsx?$/.test(path) || path.endsWith(".test.ts") || path.endsWith(".test.tsx")) return;
  if (OWN.has(path)) selfStale = true;
  pending.add(path);
  clearTimeout(settle);
  settle = setTimeout(() => {
    const batch = [...pending];
    pending.clear();
    void Promise.all(batch.map(parsed)).then((changes) => {
      // The standing request is re-read HERE, not just on the timer below, because the timer is a
      // second behind by construction and this is the moment the mode decides something. Measured
      // 2026-09-15: a reader who chose manual and saved a file within the second got the restart
      // they had just asked not to have, because the command was still in flight through the
      // sidecar and onto the board when the batch was judged.
      readRequest();
      gate.changed(changes);
    });
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

/**
 * Stop, and let whatever started this start a newer one.
 *
 * The only way a supervisor replaces itself. Every alternative either loses the child or risks two
 * supervisors on one port: exec would leave the running sidecar with nobody owning it, and spawning
 * a replacement before exiting would race the parent's own restart. Leaving is the honest version.
 * The Mac's host restarts this within a second of the exit (`AgentFeedSidecarProcess` schedules on
 * termination, backing off from 1s and resetting as soon as the new sidecar answers), and a peer's
 * watcher checks again shortly after every ship (`tools/remote-sidecar.sh`).
 *
 * What does not survive is the panel's standing request, which the new supervisor clears at startup
 * on purpose. The panel says it again within its own poll, which is what `reconcile` in
 * `packages/AgentPanel/Web/src/app/dev-server/panelPublish.ts` is for.
 */
function leave(why: string): void {
  if (stopping) return;
  stopping = true;
  clearTimeout(settle);
  clearInterval(requests);
  say(why);
  clearSupervisorDescriptor();
  if (!child) process.exit(0);
  // The child holds the port, so leaving before it is gone hands the next launch a bound port --
  // and a child that outlives this is an orphan nothing will ever stop. So this waits for the exit,
  // and `stopChild` makes sure there is one, escalating inside the two seconds the host allows
  // before it kills this process. The timer is only for a child the kernel cannot reap, which
  // SIGKILL does not fix either. A supervisor killed with SIGKILL cannot do even this, which is
  // why `host-login` reclaims the sidecar ports before it starts anything.
  stopChild(child, say);
  void child.exited.then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000);
}

process.on("SIGTERM", () => leave("SIGTERM; stopping the sidecar"));
process.on("SIGINT", () => leave("SIGINT; stopping the sidecar"));
process.on("SIGHUP", () => leave("SIGHUP; stopping the sidecar"));

say(`supervising ${SERVER}, and watching ${OWN.size} files of its own`);
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
