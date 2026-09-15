// The dev server stops pushing every save and starts publishing the ones that compile.
//
// The panel is read while it is being edited, often by an agent, and Vite hands over whatever is on
// disk the instant it lands. A file saved halfway through an edit is a file on disk: the browser
// fetched it, the module threw or would not parse, and the surface the reader was in the middle of
// using went to an error overlay or a white page for as long as it took the next save to arrive.
// Nothing about that is Vite being wrong. It is a firehose pointed at a room somebody is sitting in.
//
// So a change to a `.ts` or `.tsx` file is HELD here instead of sent, and a typechecker running in
// watch mode decides when the tree is worth handing over. Green flushes everything it has judged;
// red keeps holding and says which file and which error is in the way. Neither state is silent --
// the Profile row shows what is held and why, because a page quietly behind the tree is the failure
// this replaces, not the one it accepts.
//
// What is deliberately NOT held: stylesheets and assets, which cannot break a render, and a full
// page load, which still transforms whatever is on disk and still reports its own failure through
// Vite's overlay. The gate covers the live update path, which is the one that interrupts somebody.

import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import type { HotUpdateOptions, Plugin, ViteDevServer } from "vite";

/** The shape the Profile row reads. Declared in `features/profile/panelBuildRoute.ts`. */
export interface PublishReport {
  build: string;
  held: string[];
  blocked: string | null;
  checking: boolean;
  unfiltered: boolean;
}

/** Everything the gate does to the world, so its decisions can be tested without a dev server. */
export interface PublishGateIO {
  /**
   * Run something after a delay, cancellable.
   *
   * The gate acts on a verdict a moment late on purpose: see `GRACE_MS`. Injected rather than
   * reached for, because a race is not a thing you can test by waiting.
   */
  defer(run: () => void, ms: number): () => void;
  /** Hand one held file to the page. */
  release(file: string): void;
  /** Tell every open page what the gate is doing. */
  broadcast(report: PublishReport): void;
  /** Say out loud that the gate has stopped gating. */
  warn(message: string): void;
  /** The build id of the tree as it is right now. */
  buildId(): string;
}

/** Only these are held. A stylesheet cannot take a render down, and holding one would just delay it. */
const HELD_EXTENSIONS = /\.(ts|tsx)$/;

/** `src/app/main.tsx(12,3): error TS2304: Cannot find name 'foo'.` under `--pretty false`. */
const TYPECHECK_ERROR = /^(\S.*?\(\d+,\d+\)): (error TS\d+: .*)$/;

/** tsc's own end-of-run line, whatever timestamp prefix it carries. */
const TYPECHECK_DONE = /Found (\d+) error/;

/** tsc says one of these on the first run and at the start of every incremental one. */
const TYPECHECK_STARTED = /(Starting compilation in watch mode|File change detected)/;

/**
 * How long a green verdict waits before the held work is handed over.
 *
 * A verdict is about the tree as the run BEGAN, so a save landing mid-run is unjudged by it and
 * publishing on that verdict would be the original bug one race late. tsc starts another run for
 * that save within its own debounce, and the start of a run takes the pending handover back.
 *
 * This replaced a comparison of each file's mtime against the run's start, which looked equivalent
 * and had a state the tree could get stuck in: restore a file to its previous contents and tsc sees
 * no change at all, so it never runs again, so the newer mtime never gets a later verdict to clear
 * it. Measured -- the file sat held with nothing blocking it until the next unrelated edit. Waiting
 * on the NEXT RUN rather than on a timestamp has no such state: the wait is always either superseded
 * or spent.
 */
const GRACE_MS = 400;

/**
 * How long a hold waits when there is nothing deciding about it and nothing objecting.
 *
 * The same silence, reached from the other side. Vite sees a write the moment it lands; tsc only
 * sees it if the TEXT changed, so a file written back to what it already was is held here and
 * judged nowhere. Silence for this long means the typechecker had nothing to say about the write,
 * so the verdict it last gave still stands and the hold can go.
 *
 * Longer than the grace above because it is waiting for a run to START rather than to finish, and
 * tsc's own watch debounce is a quarter second before it says anything at all. It costs nothing on
 * the ordinary path, where a verdict arrives and cancels this.
 */
const SILENCE_MS = 1_500;

/**
 * What is held, what is blocking it, and when it goes.
 *
 * Separated from the plugin because every interesting decision here is a race with something: a
 * save that lands while the typechecker is mid-run, a green verdict about a tree that has already
 * moved on, a typechecker that dies. None of those are reachable by starting a real dev server, and
 * all of them decide whether a reader's panel goes blank.
 */
export function createPublishGate(io: PublishGateIO) {
  /** Absolute paths changed on disk and not handed over, in the order they changed. */
  const held = new Set<string>();
  /** Files being handed over right now: one-shot permission for the update that follows. */
  const released = new Set<string>();
  let checking = false;
  let blocked: string | null = null;
  let unfiltered = false;
  /** Cancels a handover this gate has decided on but not yet performed. */
  let cancelPending: (() => void) | undefined;

  const report = (): PublishReport => ({
    build: io.buildId(),
    held: [...held].map((file) => basename(file)),
    blocked,
    checking,
    unfiltered,
  });

  const broadcast = () => io.broadcast(report());

  const abort = () => {
    cancelPending?.();
    cancelPending = undefined;
  };

  /**
   * Hands held files over by replaying the change that was suppressed, so the update takes the
   * whole ordinary path -- react-refresh boundaries included, which is what keeps a component edit
   * from reloading the page and losing what the reader was looking at.
   */
  const flush = () => {
    abort();
    for (const file of [...held]) {
      held.delete(file);
      released.add(file);
      io.release(file);
    }
    broadcast();
  };

  return {
    report,

    /** True when the update for this file should be suppressed. */
    hold(file: string): boolean {
      if (unfiltered) return false;
      if (!HELD_EXTENSIONS.test(file)) return false;
      // One-shot: this is the replay `flush` asked for, so it goes through untouched.
      if (released.delete(file)) return false;
      held.add(file);
      broadcast();
      // Nothing is deciding and nothing objects, so unless the typechecker speaks up this write did
      // not change the tree and the standing verdict covers it.
      if (!checking && blocked === null) {
        abort();
        cancelPending = io.defer(flush, SILENCE_MS);
      }
      return true;
    },

    /** One line of the typechecker's watch output. */
    readTypecheckLine(line: string): void {
      if (unfiltered) return;
      if (TYPECHECK_STARTED.test(line)) {
        // Whatever handover was pending was decided about a tree that has already moved.
        abort();
        checking = true;
        blocked = null;
        broadcast();
        return;
      }
      const failure = TYPECHECK_ERROR.exec(line);
      // The FIRST error of the run, not the last: a later one is usually the same mistake seen from
      // another file, and the row has one line to say what is in the way.
      if (failure && blocked === null) {
        blocked = `${basename(failure[1] ?? "")}: ${failure[2] ?? ""}`;
        return;
      }
      const done = TYPECHECK_DONE.exec(line);
      if (!done) return;
      checking = false;
      if (done[1] === "0") {
        blocked = null;
        broadcast();
        if (held.size > 0) cancelPending = io.defer(flush, GRACE_MS);
        return;
      }
      // Kept from the error lines above, unless the count arrived without one this could parse, in
      // which case the count itself is the honest answer.
      blocked ??= `${done[1]} typecheck errors`;
      broadcast();
    },

    /** Hand over what is held now, whatever the typechecker thinks of it. */
    publish(): void {
      flush();
    },

    /**
     * Loses the gate rather than the dev loop.
     *
     * A dev server that stops delivering edits because its gatekeeper died is worse than one that
     * delivers them unfiltered, so this fails open. It is not silent: the warning goes to the
     * server's log and `unfiltered` puts it on the Profile row, because a reader who cannot tell
     * the two apart gets the worst of both.
     */
    giveUp(why: string): void {
      if (unfiltered) return;
      unfiltered = true;
      checking = false;
      blocked = null;
      io.warn(`${why}; updates are going through unfiltered`);
      flush();
    },

    /** The typechecker is up and has begun its first run. */
    begin(): void {
      checking = true;
      broadcast();
    },
  };
}

/** What the plugin needs to know, all of it passed in: see `panelBuildRoute.ts` for why. */
export interface PanelPublishOptions {
  /** Where a page asks for the current report. */
  buildRoute: string;
  /** Where a caller asks for what is held to be handed over now. */
  publishRoute: string;
  /** The custom dev-server event each report is pushed on. */
  event: string;
  /** The build id of the tree as it is right now. */
  buildId: () => string;
  /**
   * The typechecker to run in watch mode. Environment-dependent (a path into this package's own
   * `node_modules`), so it is resolved by the config rather than spelled here.
   */
  typecheck: { command: string; args: string[]; cwd: string };
}

export function panelPublish(options: PanelPublishOptions): Plugin {
  let server: ViteDevServer | undefined;
  let checker: ChildProcess | undefined;

  const gate = createPublishGate({
    defer: (run, ms) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    },
    // Replayed through the watcher rather than sent directly, so the suppressed change runs the
    // same path it would have run had the gate never been there.
    release: (file) => server?.watcher.emit("change", file),
    broadcast: (report) => server?.environments.client.hot.send(options.event, report),
    warn: (message) => server?.config.logger.warn(`[panel-publish] ${message}`),
    buildId: options.buildId,
  });

  const startTypechecker = () => {
    const { command, args, cwd } = options.typecheck;
    let child: ChildProcess;
    try {
      child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      gate.giveUp(`could not start ${command} (${String(error)})`);
      return;
    }
    checker = child;
    gate.begin();

    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      // The last piece may be half a line; tsc writes its verdict and its errors on separate ones.
      buffered = lines.pop() ?? "";
      for (const line of lines) gate.readTypecheckLine(line.trim());
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      server?.config.logger.warn(`[panel-publish] typecheck: ${chunk.toString().trim()}`);
    });
    child.on("error", (error) => gate.giveUp(`the typechecker failed (${error.message})`));
    child.on("exit", (code) => {
      checker = undefined;
      gate.giveUp(`the typechecker exited with ${code ?? "a signal"}`);
    });
  };

  const stopTypechecker = () => {
    checker?.kill("SIGTERM");
    checker = undefined;
  };

  return {
    name: "agent-panel-publish",

    // Last, so a plugin that means to widen an update (react-refresh does) has already had its say
    // and this decides only whether the result travels.
    hotUpdate: {
      order: "post",
      handler({ file, modules }: HotUpdateOptions) {
        if (modules.length === 0) return;
        return gate.hold(file) ? [] : undefined;
      },
    },

    configureServer(dev) {
      server = dev;
      startTypechecker();
      dev.httpServer?.once("close", stopTypechecker);
      process.once("exit", stopTypechecker);

      dev.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0] ?? "";
        if (path !== options.buildRoute && path !== options.publishRoute) return next();
        if (path === options.publishRoute) {
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.setHeader("content-type", "text/plain; charset=utf-8");
            response.end("publish is a POST\n");
            return;
          }
          gate.publish();
        }
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(JSON.stringify(gate.report()));
      });
    },
  };
}
