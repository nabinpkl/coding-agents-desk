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
// Parsed rather than typechecked, and that is a deliberate downgrade from the first version of this
// gate. A resident `tsc --watch` per tree cost 844MB at its peak on this machine, measured with
// `footprint`, which is a lot to pay for a dev-loop convenience on a Mac already 6.5GB into swap.
// It was also the wrong instrument: neither the panel nor the sidecar typechecks at runtime, both
// strip types, so a type error cannot take a page down and was never what broke anything. Half a
// file is. `just check` is still where a type error is caught.
//
// What is deliberately NOT held: stylesheets and assets, which cannot break a render, and a full
// page load, which still transforms whatever is on disk and still reports its own failure through
// Vite's overlay. The gate covers the live update path, which is the one that interrupts somebody.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { transformWithEsbuild, type HotUpdateOptions, type Plugin, type ViteDevServer } from "vite";

/** The shape the Profile row reads. Declared in `features/profile/panelBuildRoute.ts`. */
export interface PublishReport {
  build: string;
  held: string[];
  blocked: string | null;
  sidecar: SupervisorReport | null;
}

/** What the sidecar's supervisor writes on its board file. Its own shape, in its own process. */
export interface SupervisorReport {
  held: boolean;
  blocked: string | null;
}

/** Everything the gate does to the world, so its decisions can be tested without a dev server. */
export interface PublishGateIO {
  /** Tell every open page what the gate is doing. */
  broadcast(report: PublishReport): void;
  /** The build id of the tree as it is right now. */
  buildId(): string;
  /** What the sidecar's supervisor is doing, or null when there is no live one to ask. */
  sidecar(): SupervisorReport | null;
}

/** Only these are held. A stylesheet cannot take a render down, and holding one would just delay it. */
const HELD_EXTENSIONS = /\.(ts|tsx)$/;

/**
 * How old the sidecar supervisor's board file may be before it reads as no supervisor at all.
 *
 * Three missed heartbeats, which is what the sidecar board itself ages a descriptor out at. A
 * supervisor that died leaves its last state on disk, and showing that as live would put a frozen
 * report on the one row whose whole job is to say whether what you are looking at is current.
 */
const SUPERVISOR_STALE_MS = 15_000;

/** How often the board file is re-read, since a process that dies produces no filesystem event. */
const SUPERVISOR_POLL_MS = 2_000;

/**
 * What is held and why.
 *
 * Separated from the plugin because the plugin is all process and filesystem, and this is the part
 * that decides whether a reader's panel keeps working.
 */
export function createPublishGate(io: PublishGateIO) {
  /** Absolute path to why it will not parse, for each file not handed over. */
  const held = new Map<string, string>();

  const report = (): PublishReport => ({
    build: io.buildId(),
    held: [...held.keys()].map((file) => basename(file)),
    // The first one still held, which is the one a reader can act on. Named by file, because the
    // row is one line wide and the path is the half that does not fit.
    blocked: firstReason(held),
    sidecar: io.sidecar(),
  });

  const broadcast = () => io.broadcast(report());

  return {
    report,

    /**
     * Whether this file's update should be suppressed.
     *
     * `failure` is why it would not parse, or null for a file that is whole. A file that parses is
     * handed over immediately and clears any hold it had: the save that fixes a half-written file
     * IS the update the reader is waiting for, so there is nothing left to replay afterwards.
     */
    hold(file: string, failure: string | null): boolean {
      if (!HELD_EXTENSIONS.test(file)) return false;
      if (failure === null) {
        if (held.delete(file)) broadcast();
        return false;
      }
      if (held.get(file) === failure) return true;
      held.set(file, failure);
      broadcast();
      return true;
    },

    /** Say the current state again, for a change this gate did not itself make. */
    announce(): void {
      broadcast();
    },
  };
}

/** The first file still held, said the way the row shows it. */
function firstReason(held: Map<string, string>): string | null {
  for (const [file, failure] of held) return `${basename(file)}: ${failure}`;
  return null;
}

/** What the plugin needs to know, all of it passed in: see `panelBuildRoute.ts` for why. */
export interface PanelPublishOptions {
  /** Where a page asks for the current report. */
  buildRoute: string;
  /** The custom dev-server event each report is pushed on. */
  event: string;
  /** The build id of the tree as it is right now. */
  buildId: () => string;
  /**
   * The file the sidecar's supervisor heartbeats its own state onto.
   *
   * A file rather than a request, because the supervisor is the sidecar's PARENT and serves nothing
   * itself: asking the sidecar would be asking the process being held back whether it is being held
   * back. It sits on the rendezvous board this machine already keeps, beside the descriptor each
   * sidecar announces itself with.
   */
  supervisorBoard: string;
}

/**
 * The supervisor's state, or null when there is no live supervisor behind this panel.
 *
 * An absent file is the ordinary answer, not an error: a bundled sidecar has no supervisor and never
 * writes one. A file older than three heartbeats is treated the same way, because the alternative is
 * putting a dead process's last words on the one row whose job is to say what is current.
 */
function readSupervisorBoard(file: string): SupervisorReport | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const heartbeat = typeof raw.heartbeat === "number" ? raw.heartbeat : 0;
  if (Date.now() - heartbeat > SUPERVISOR_STALE_MS) return null;
  return {
    held: raw.held === true,
    blocked: typeof raw.blocked === "string" ? raw.blocked : null,
  };
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

export function panelPublish(options: PanelPublishOptions): Plugin {
  let server: ViteDevServer | undefined;

  const gate = createPublishGate({
    broadcast: (report) => server?.environments.client.hot.send(options.event, report),
    buildId: options.buildId,
    sidecar: () => readSupervisorBoard(options.supervisorBoard),
  });

  return {
    name: "agent-panel-publish",

    // Last, so a plugin that means to widen an update (react-refresh does) has already had its say
    // and this decides only whether the result travels.
    hotUpdate: {
      order: "post",
      async handler({ file, modules, read }: HotUpdateOptions) {
        if (modules.length === 0 || !HELD_EXTENSIONS.test(file)) return;
        const failure = await parseFailure(file, await read());
        return gate.hold(file, failure) ? [] : undefined;
      },
    },

    configureServer(dev) {
      server = dev;

      // Polled rather than watched: the state that matters most is a supervisor that STOPPED, and a
      // process that dies produces no filesystem event. Pushed only when it actually moved, so a
      // quiet machine costs one small read every couple of seconds and no traffic at all.
      let last = "";
      const poll = setInterval(() => {
        const now = JSON.stringify(readSupervisorBoard(options.supervisorBoard));
        if (now === last) return;
        last = now;
        gate.announce();
      }, SUPERVISOR_POLL_MS);
      poll.unref?.();
      dev.httpServer?.once("close", () => clearInterval(poll));

      dev.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0] ?? "";
        if (path !== options.buildRoute) return next();
        response.statusCode = 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.end(JSON.stringify(gate.report()));
      });
    },
  };
}
