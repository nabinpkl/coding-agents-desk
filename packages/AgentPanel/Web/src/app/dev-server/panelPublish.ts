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

import { basename } from "node:path";
import { transformWithEsbuild, type HotUpdateOptions, type Plugin, type ViteDevServer } from "vite";

/** The shape the Profile row reads. Declared in `features/profile/panelBuildRoute.ts`. */
export interface PublishReport {
  build: string;
  held: string[];
  blocked: string | null;
  sidecars: SupervisorReport[];
}

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
}

/** Everything the gate does to the world, so its decisions can be tested without a dev server. */
export interface PublishGateIO {
  /** Tell every open page what the gate is doing. */
  broadcast(report: PublishReport): void;
  /** The build id of the tree as it is right now. */
  buildId(): string;
  /** What each machine's sidecar supervisor is doing, for every one still answering. */
  sidecars(): SupervisorReport[];
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
  /** Absolute path to why it will not parse, for each file not handed over. */
  const held = new Map<string, string>();

  const report = (): PublishReport => ({
    build: io.buildId(),
    held: [...held.keys()].map((file) => basename(file)),
    // The first one still held, which is the one a reader can act on. Named by file, because the
    // row is one line wide and the path is the half that does not fit.
    blocked: firstReason(held),
    // Only the ones with something to say. A machine that is merely running is not news, and the
    // row is built to render nothing at all when there is nothing to render.
    sidecars: io.sidecars().filter((sidecar) => sidecar.held),
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
   * What each machine's sidecar supervisor is holding.
   *
   * Resolved by the config rather than read here, because the answer comes from `/api/config` on
   * every sidecar this server knows -- which the session plugin already asks on a timer to see
   * whether each one is alive. A supervisor serves nothing itself, so asking a sidecar is the only
   * way to hear about a peer's at all, and riding an answer somebody is already waiting for costs
   * no request.
   */
  supervisors: () => SupervisorReport[];
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
    sidecars: options.supervisors,
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

      // Polled rather than pushed: the list is refreshed by another plugin on its own clock, and
      // the state that matters most is a supervisor that STOPPED, which produces no event anywhere.
      // Compared rather than sent, so a quiet machine costs one string comparison and no traffic.
      let last = "";
      const poll = setInterval(() => {
        const now = JSON.stringify(gate.report().sidecars);
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
