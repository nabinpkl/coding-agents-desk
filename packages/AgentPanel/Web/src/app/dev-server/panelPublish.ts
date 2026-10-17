// The dev server stops pushing every save and starts publishing the ones that are whole files.
//
// The panel is read while it is being edited, often by an agent, and Vite hands over whatever is on
// disk the instant it lands. A file saved halfway through an edit is a file on disk: the browser
// fetched it, the module would not parse, and the surface the reader was in the middle of using
// went to an error overlay for as long as it took the next save to arrive. Nothing about that is
// Vite being wrong. It is a firehose pointed at a room somebody is sitting in.
//
// So an update is PARSED here before it is sent, and a file that is not yet a file is held back
// until a later save completes it. The reader keeps the last version that was whole, and the
// Profile row says what is being held and why, because a page quietly behind the tree is the
// failure this replaces, not one it accepts.
//
// A whole file is then typechecked with the code it lands among before it is sent (`typeHolds.ts`),
// because whole files that disagree broke the page too: on 2026-10-16 a hook saved before its
// caller blanked the Feed tab with `all.map is not a function`. The first version of this gate ran
// a resident `tsc --watch` and was dropped at 844MB; TypeScript 7 checks the page's code in about a
// second in a child that exits, which is what made it affordable again. Only an error the edit
// introduced holds anything, and only the files it could break.
//
// What is deliberately NOT held: stylesheets and assets, which cannot break a render, and a full
// page load, which still transforms whatever is on disk and still reports its own failure through
// Vite's overlay. The gate covers the live update path, which is the one that interrupts somebody.
//
// The same gate takes the reader's own answer to a second question, which the parse cannot answer
// for them: whether a file that IS whole should arrive while they are in the middle of using the
// page. An update that parses is still a remount, and a reader watching a session through an edit
// storm did not ask for one every few seconds. In `manual` the whole files queue with the broken
// ones and the reader releases them, by a reload, which is the only honest release there is: an
// update Vite was not allowed to send is gone rather than parked.
//
// It also tells this Mac's sidecar supervisor what the panel's tree is doing -- when a file last
// changed, and whether one will not parse -- so a sidecar restart waits for an agent's panel edits
// to settle too (`agent-feed/sidecar/src/supervisor/`). It used to go further and hold the panel's
// own updates while a sidecar change was waiting, reloading every page once the new sidecar was up;
// with several agents editing both trees that turned live updates into full reloads more often than
// it saved one, so the panel side now only reports and never waits.

import { basename } from "node:path";
import {
  transformWithEsbuild,
  type EnvironmentModuleNode,
  type HotUpdateOptions,
  type Plugin,
  type ViteDevServer,
} from "vite";

/** The shape the Profile row reads. Declared in `features/profile/panelBuildRoute.ts`. */
export interface PublishReport {
  build: string;
  mode: UpdateMode;
  held: string[];
  blocked: string | null;
  sidecars: SupervisorReport[];
}

/**
 * Whether a change that parses is sent as it lands, or waits for the reader to ask.
 *
 * Declared here as well as in `features/profile/panelBuildRoute.ts` rather than imported from it,
 * for the reason that module's own header gives: this one is loaded by `vite.config.ts` before the
 * panel's aliases exist. `vite.config.ts` is where the two ends are wired together.
 */
export type UpdateMode = "auto" | "manual";

/**
 * One machine's sidecar supervisor, as the dev server heard it.
 *
 * A list rather than one, because the panel reads more than one machine: a session on an ssh peer
 * is served by that peer's own sidecar, gated by that peer's own supervisor, and a reader looking
 * at its feed has no way to tell a held sidecar there from a session that has gone quiet.
 */
export interface SupervisorReport {
  /** The label the reader knows the machine by, which is how the row names it. */
  machine: string;
  held: boolean;
  blocked: string | null;
  /** Whether that machine takes a tree that parses at once, or waits to be asked. */
  mode: UpdateMode;
  /**
   * True when the sidecar is running different code from this Mac's tree: its `sourceVersion`
   * differs from the same hash of the files the panel is served from. Held back by its supervisor,
   * or a peer nobody has shipped to; either way, routes the panel's code expects may not be there.
   */
  behind: boolean;
}

/** Everything the gate does to the world, so its decisions can be tested without a dev server. */
export interface PublishGateIO {
  /** Tell every open page what the gate is doing. */
  broadcast(report: PublishReport): void;
  /** The build id of the tree as it is right now. */
  buildId(): string;
  /** What each machine's sidecar supervisor is doing, for every one still answering. */
  sidecars(): SupervisorReport[];
  /**
   * Put every open page on the tree as it is now.
   *
   * The only way to hand over an update that was withheld: Vite drops an update whose module list
   * came back empty, so nothing is kept anywhere to replay. Every surface rather than the one whose
   * reader pressed it, because the mode is the server's, and a phone left on the same panel would
   * otherwise keep running code the Mac has moved past.
   */
  reload(): void;
  /**
   * Pass a command on to every machine's supervisor.
   *
   * The MODE is one switch for the panel and every sidecar, because a reader who asks for the page
   * to stop changing under them is not asking about only one of those. Taking what is held is two
   * decisions: a supervisor holds a RESTART, which costs more than a reload -- every stream the
   * panel is holding dies with the process, the desktop encoders with it, and terminals re-import
   * their scrollback -- so the sidecars restart on their own button, all of them together, since
   * the Mac and a peer run one tree between them.
   */
  tell(command: UpdateMode | "apply"): void;
  /** What the reader chose last time there was a server, and where this one records their choice. */
  remembered(): UpdateMode;
  remember(mode: UpdateMode): void;
  /** Tell this Mac's supervisor what the panel's tree is doing, so a restart can wait for it. */
  recordActivity?(activity: { changedAt: number; blocked: string | null }): void;
}

/** Only these are held. A stylesheet cannot take a render down, and holding one would just delay it. */
const HELD_EXTENSIONS = /\.(ts|tsx)$/;

/** How often the machines' states are compared, since nothing pushes a change here. */
const SUPERVISOR_POLL_MS = 2_000;


/**
 * What is held and why.
 *
 * Separated from the plugin because the plugin is all process and filesystem, and this is the part
 * that decides whether a reader's panel keeps working.
 */
export function createPublishGate(io: PublishGateIO) {
  /** Absolute path to why it will not parse, or null for a whole file waiting on the reader. */
  const held = new Map<string, string | null>();

  /** Whole files held because the code they land among does not typecheck, and why. */
  let typeHeld = new Map<string, string>();

  /** When a panel source last changed, carried on every heartbeat to the supervisor. */
  let changedAt = 0;

  /** Why the queue cannot go out: a file that will not parse, or failing that one that will not check. */
  const blocked = () => firstReason(held) ?? firstTypeReason(typeHeld);

  const recordActivity = () => io.recordActivity?.({ changedAt, blocked: blocked() });

  /**
   * What the reader last chose, which outlives the server that was asked.
   *
   * A restart is one of the things somebody is asking to be protected from when they choose to hold
   * updates, so forgetting on one would undo the request at the moment it was most wanted. Safe to
   * carry because the strip says which mode is in force at rest, with nothing waiting: a mode that
   * came back from yesterday is on screen rather than implied.
   */
  let mode: UpdateMode = io.remembered();

  const report = (): PublishReport => ({
    build: io.buildId(),
    mode,
    held: [...new Set([...held.keys(), ...typeHeld.keys()])].map((file) => basename(file)),
    // The first held file that will not parse, which is the one a reader can do something about
    // and the one that decides whether the queue can be applied at all, or failing that the first
    // waiting on a type error. Named by file, because the row is one line wide and the path is the
    // half that does not fit.
    blocked: blocked(),
    // Only the ones with something to say. A machine that is merely running is not news, and the
    // row is built to render nothing at all when there is nothing to render.
    sidecars: io.sidecars().filter((sidecar) => sidecar.held || sidecar.behind),
  });

  const broadcast = () => io.broadcast(report());

  /**
   * Hand over everything being held for the reader rather than for the parser.
   *
   * Refused while any held file will not parse, because a reload would land on exactly the broken
   * page this gate exists to prevent. Nothing is said about that here: the row is already showing
   * which file and why, and it is the same sentence either way.
   */
  const release = (): boolean => {
    if ((held.size === 0 && typeHeld.size === 0) || firstReason(held) !== null) return false;
    held.clear();
    // A type error does not stop the reader taking the tree: they asked, and a page that does not
    // typecheck often runs. The reload is the release, so nothing is waiting afterwards.
    typeHeld = new Map();
    broadcast();
    io.reload();
    return true;
  };

  /** The body of `hold`, apart so the supervisor hears about every outcome from one place. */
  const decide = (file: string, failure: string | null): boolean => {
    if (failure === null && mode === "auto") {
      if (held.delete(file)) broadcast();
      return false;
    }
    // `has` as well as `get`, because a whole file held by the mode is recorded as null and that
    // is the value a missing key does NOT have: `undefined === null` is false.
    if (held.has(file) && held.get(file) === failure) return true;
    held.set(file, failure);
    broadcast();
    return true;
  };

  return {
    report,

    /**
     * Whether this file's update should be suppressed.
     *
     * `failure` is why it would not parse, or null for a file that is whole. Under `auto` a file
     * that parses is handed over immediately and clears any hold it had: the save that fixes a
     * half-written file IS the update the reader is waiting for, so there is nothing left to replay
     * afterwards. Under `manual` it joins the queue instead, recorded with no reason, which is what
     * separates a file waiting on the reader from one waiting on its author.
     */
    hold(file: string, failure: string | null, now = Date.now()): boolean {
      if (!HELD_EXTENSIONS.test(file)) return false;
      changedAt = now;
      const suppressed = decide(file, failure);
      recordActivity();
      return suppressed;
    },

    /** Say what the panel's tree is doing again, so the supervisor reading it knows it is alive. */
    heartbeat(): void {
      recordActivity();
    },

    /** What the reader last chose, which every machine is held to. */
    mode(): UpdateMode {
      return mode;
    },

    /** Reload every surface onto what is waiting, staying in the chosen mode. No sidecar moves. */
    apply(): boolean {
      return release();
    },

    /** Restart every held sidecar onto its tree, staying in the chosen mode. The panel stays. */
    restartSidecars(): void {
      io.tell("apply");
    },

    /** Choose whether a change that parses is acted on as it lands, here and on every machine. */
    setMode(next: UpdateMode): void {
      if (next === mode) return;
      mode = next;
      io.remember(next);
      io.tell(next);
      // Coming back to auto IS the "yes, now" the queue was waiting for, and `release` broadcasts
      // the emptied report itself.
      if (next === "auto" && release()) return;
      broadcast();
    },

    /**
     * Say it again to any machine that is not in the mode the reader chose.
     *
     * A supervisor that restarted -- a host relaunch, a crash -- comes back on auto, and would then
     * quietly start replacing its sidecar under a reader who had asked for the opposite. Without
     * this the one switch would be a claim rather than a fact.
     */
    reconcile(): void {
      if (io.sidecars().some((sidecar) => sidecar.mode !== mode)) io.tell(mode);
    },

    /** Say the current state again, for a change this gate did not itself make. */
    announce(): void {
      broadcast();
    },

    /** Which whole files are held on a type error, and why: the type hold's answer, replacing the last. */
    setTypeHeld(next: Map<string, string>): void {
      if (next.size === typeHeld.size && [...next].every(([file, why]) => typeHeld.get(file) === why)) return;
      typeHeld = next;
      broadcast();
      recordActivity();
    },
  };
}

/** The first file held on a type error, said as the file and what it is waiting on. */
function firstTypeReason(typeHeld: Map<string, string>): string | null {
  for (const [file, why] of typeHeld) return `${basename(file)} waits on ${why}`;
  return null;
}

/**
 * The first file still held that will not PARSE, said the way the row shows it.
 *
 * Not simply the first held file: under manual the queue is mostly whole files, and this is what
 * decides whether the reader is allowed to take them.
 */
function firstReason(held: Map<string, string | null>): string | null {
  for (const [file, failure] of held) if (failure !== null) return `${basename(file)}: ${failure}`;
  return null;
}

/** What the plugin needs to know, all of it passed in: see `panelBuildRoute.ts` for why. */
export interface PanelPublishOptions {
  /** Where a page asks for the current report. */
  buildRoute: string;
  /** The custom dev-server event each report is pushed on. */
  event: string;
  /** The query parameter a POST to `buildRoute` carries its command in. */
  commandParam: string;
  /** Pass a command to every machine's supervisor. */
  tell: (command: "auto" | "manual" | "apply") => void;
  /**
   * Where the reader's choice is kept between servers.
   *
   * Passed in rather than read here for the reason the rest of these are: this module is loaded by
   * `vite.config.ts` before the panel's aliases exist, so it can import nothing of its own.
   */
  remembered: () => UpdateMode;
  remember: (mode: UpdateMode) => void;
  /** The build id of the tree as it is right now. */
  buildId: () => string;
  /**
   * What each machine's sidecar supervisor is holding.
   *
   * Resolved by the config rather than read here, because the answer comes from `/api/config` on
   * every sidecar this server knows -- which the session plugin already asks on a timer to see
   * whether each one is alive. A supervisor serves nothing itself, so asking a sidecar is the only
   * way to hear about a peer's at all, and riding an answer somebody is already waiting for costs
   * no request.
   */
  supervisors: () => SupervisorReport[];
  /** Where the panel's tree activity is written for the supervisor. */
  recordActivity?: (activity: { changedAt: number; blocked: string | null }) => void;
  /**
   * Builds the type hold (`typeHolds.ts`) around the dev server, whose module graph it walks and
   * whose updates it resends. Absent, whole files go out on the parse check alone.
   */
  holdTypes?: (io: {
    server: () => ViteDevServer | undefined;
    publish(held: Map<string, string>): void;
    log(message: string): void;
  }) => { prime(): void; wait(file: string): void; clear(): void };
}

/**
 * Why this source will not parse, or null when it is whole.
 *
 * esbuild through Vite's own export, so the question asked is the one Vite would ask a moment later
 * when the browser requests the module, rather than a second opinion that can disagree with it. It
 * costs about a millisecond and no resident memory, which is the whole reason this replaced a
 * typechecker.
 */
export async function parseFailure(file: string, source: string): Promise<string | null> {
  try {
    await transformWithEsbuild(source, file);
    return null;
  } catch (error) {
    const first = (error as { errors?: { text?: string; location?: { line?: number } }[] }).errors?.[0];
    if (!first?.text) return (error as Error).message.split("\n")[0] ?? "will not parse";
    return first.location?.line ? `${first.text} (line ${first.location.line})` : first.text;
  }
}

/**
 * Whether the page has never loaded this module, so an update to it has nobody to reach.
 *
 * Tailwind scans every source file for class names and registers each with Vite, so files the
 * page never runs -- tests, test harnesses, modules imported only for their types -- sit in the
 * module graph with nothing but the stylesheet importing them. Saving one was an update no module
 * accepts, and Vite answers that by reloading every open panel: measured 2026-10-14, 168 of 293
 * full reloads since 2026-09-30 were test files, and about 19 more were harnesses and type-only
 * modules. A module the page did load has compiled at least once and recorded its own imports;
 * one that never did has none, and only stylesheets above it. `main.tsx` is imported by nothing
 * and still reloads, because it has imports of its own.
 */
export function neverLoaded(module: Pick<EnvironmentModuleNode, "importedModules" | "importers">): boolean {
  if (module.importedModules.size > 0) return false;
  for (const importer of module.importers) if (!importer.file?.endsWith(".css")) return false;
  return true;
}

export function panelPublish(options: PanelPublishOptions): Plugin {
  let server: ViteDevServer | undefined;

  const types = options.holdTypes?.({
    server: () => server,
    publish: (held) => gate.setTypeHeld(held),
    log: (message) => console.warn(`[panel-publish] ${message}`),
  });

  const gate = createPublishGate({
    recordActivity: options.recordActivity,
    broadcast: (report) => server?.environments.client.hot.send(options.event, report),
    buildId: options.buildId,
    sidecars: options.supervisors,
    reload: () => {
      types?.clear();
      server?.environments.client.hot.send({ type: "full-reload" });
    },
    tell: options.tell,
    remembered: options.remembered,
    remember: options.remember,
  });

  return {
    name: "agent-panel-publish",

    // Last, so a plugin that means to widen an update (react-refresh does) has already had its say
    // and this decides only whether the result travels.
    hotUpdate: {
      order: "post",
      async handler({ file, modules, read }: HotUpdateOptions) {
        if (modules.length === 0) return;
        // Nothing on the page runs it, so there is nothing to update and no reason to reload.
        if (modules.every(neverLoaded)) return [];
        if (!HELD_EXTENSIONS.test(file)) return;
        const failure = await parseFailure(file, await read());
        if (gate.hold(file, failure, Date.now())) return [];
        if (!types) return;
        // Whole, and under auto: it goes out once the tree it lands in typechecks.
        types.wait(file);
        return [];
      },
    },

    configureServer(dev) {
      server = dev;
      types?.prime();

      // Polled rather than pushed: the list is refreshed by another plugin on its own clock, and
      // the state that matters most is a supervisor that STOPPED, which produces no event anywhere.
      // Compared rather than sent, so a quiet machine costs one string comparison and no traffic.
      let last = "";
      const poll = setInterval(() => {
        gate.reconcile();
        const now = JSON.stringify(gate.report().sidecars);
        if (now === last) return;
        last = now;
        gate.announce();
      }, SUPERVISOR_POLL_MS);
      poll.unref?.();
      dev.httpServer?.once("close", () => clearInterval(poll));

      // Keeps the supervisor's view of the panel alive: a panel that stops saying anything reads to it
      // as no panel at all, and it then waits on its own tree alone.
      const heartbeat = setInterval(() => gate.heartbeat(), SUPERVISOR_POLL_MS);
      heartbeat.unref?.();
      dev.httpServer?.once("close", () => clearInterval(heartbeat));

      dev.middlewares.use((request, response, next) => {
        // The base is never used: `request.url` on a server is a path, and `URL` only insists on
        // having something to resolve it against.
        const asked = new URL(request.url ?? "/", "http://panel");
        if (asked.pathname !== options.buildRoute) return next();

        if (request.method === "POST") {
          const command = asked.searchParams.get(options.commandParam);
          if (command === "auto" || command === "manual") gate.setMode(command);
          else if (command === "apply") gate.apply();
          else if (command === "restart") gate.restartSidecars();
          else {
            // Answering 200 to a command this does not understand would leave a toggle reporting a
            // mode nobody is in, which is the one failure a control like this must not have.
            response.statusCode = 400;
            response.end(`unknown ${options.buildRoute} command`);
            return;
          }
        }

        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(JSON.stringify(gate.report()));
      });
    },
  };
}
