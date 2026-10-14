// When the sidecar is worth restarting, and when a change should be sat on.
//
// The live sidecar arm runs the WORKING TREE, so a file saved halfway through an edit is the file
// that runs. Under `bun --watch` it re-read on every write, and a save mid-edit threw during the
// reload: measured on this repo, that leaves the process alive with its port free, so every stream
// the panel holds dies at once and nothing notices until the host's port probe gives up a minute
// later. The panel keeps rendering the whole time with no data behind it.
//
// So a write no longer restarts anything by itself. The changed files are PARSED first, and the
// sidecar is replaced only once every one of them is a whole file. Same idea as the panel's publish
// gate (`packages/AgentPanel/Web/src/app/dev-server/panelPublish.ts`) and deliberately a separate
// copy: the two trees share only the wire contract, which is types.
//
// It answers a second question too, and only the reader can: whether a tree that DOES parse is
// worth restarting into right now. A restart is not free to whoever is reading the panel -- every
// stream the sidecar holds dies with the process, the desktop encoders go with it, and terminals
// re-import their scrollback. Measured here 2026-09-15, three restarts inside 32 seconds during one
// editing burst. On `manual` the change is recorded and the running sidecar is left alone until the
// reader asks, which is strictly safer than the panel's half of the same switch: the old sidecar
// keeps serving the whole time, and taking the tree later is just a restart.
//
// Whole files are not the whole question. A tree in which every file parses can still fail to start
// -- the caller saved before the callee, importing a name that does not exist yet -- and the restart
// that takes it stops the old sidecar first, so nothing serves until a later save fixes it. The
// supervisor therefore also resolves the import graph before a restart (`supervisorLinks.ts`), and
// a tree that will not link is held exactly like one that will not parse. Unlike a broken file it
// is a property of the TREE, not of one path: the save that fixes it is often a different file, so
// it is re-asked on every batch rather than cleared by the file that caused it.
//
// And a tree that is whole and links is still not necessarily the one to restart into. An agent's
// change is several saves, sidecar and panel both -- a route renamed here, its caller there -- and a
// restart on the first of them puts the panel against a sidecar it does not match. So under `auto`
// the restart waits until the sidecar's tree AND the panel's have been quiet for `quietMs`, and
// until no panel file is half-written; the panel's dev server says what its side is doing through
// `supervisorBoard.ts`, and holds its own updates while this waits (its half is in
// `packages/AgentPanel/Web/src/app/dev-server/panelPublish.ts`). Taking the tree on the reader's
// say-so does not wait for anything.
//
// Parsed rather than typechecked. The first version of this ran `tsc --noEmit --watch` as the
// watcher and the judge, which cost 844MB at its peak here, measured with `footprint`. It was also
// the wrong instrument: bun strips types and never checks them, so a type error cannot break a
// running sidecar and was never what broke one. Half a file is. `just check` still catches types.

import type { SupervisorMode } from "@agentdesk/agent-feed-wire";
import type { PanelActivity } from "@/supervisor/supervisorBoard";

/** What a changed file is, once somebody has tried to parse it. */
export interface ParsedChange {
  /** Absolute path, as the watcher reported it. */
  path: string;
  /** Why it will not parse, or null for a whole file. */
  failure: string | null;
}

export interface SupervisorGateIO {
  /** Replace the running sidecar with one reading the tree as it is now. */
  restart(reason: string): void;
  /** Anything a reader going backwards through the log needs: this is the only record. */
  log(message: string): void;
  /** Publish the state for the panel to show, so a held sidecar is visible and not just logged. */
  publish(state: SupervisorState): void;
}

export interface SupervisorState {
  /** True when the tree has moved since the running sidecar was started. */
  held: boolean;
  /** Which file will not parse, and why. Null when nothing is in the way. */
  blocked: string | null;
  /** Whether a tree that parses is taken at once, or waits for the reader to ask. */
  mode: SupervisorMode;
}

export interface SupervisorGateOptions {
  /**
   * How long both trees must have been quiet before an automatic restart. 0 is no window: a batch
   * that is whole and links restarts at once, unless a panel file beside it is half-written.
   */
  quietMs?: number;
}

export function createSupervisorGate(io: SupervisorGateIO, options: SupervisorGateOptions = {}) {
  const quietMs = options.quietMs ?? 0;
  /** Files that have changed since the running sidecar started, and will not parse. */
  const broken = new Map<string, string>();
  /** Why the tree as a whole will not link, as of the last batch. Null when it does. */
  let unlinked: string | null = null;
  /** What a whole tree is waiting on before it restarts by itself, said on the panel row. */
  let waitingOn: string | null = null;
  /** When the last batch arrived, which is when this tree last moved. */
  let lastChangeAt = 0;
  /** What the restart will say it took, from the batch that made the tree whole. */
  let pendingReason = "";
  /** True once anything has changed at all, so an unchanged tree is never restarted into. */
  let dirty = false;
  /** Auto until the panel says otherwise, and again whenever this process starts. */
  let mode: SupervisorMode = "auto";

  const state = (): SupervisorState => {
    const first = [...broken.entries()][0];
    return { held: dirty, blocked: first ? `${base(first[0])}: ${first[1]}` : unlinked ?? waitingOn, mode };
  };

  const publish = () => io.publish(state());

  /** Take the tree as it stands, if there is one to take and it is whole and links. */
  const take = (reason: string): boolean => {
    if (!dirty || broken.size > 0 || unlinked !== null) return false;
    dirty = false;
    waitingOn = null;
    publish();
    io.restart(reason);
    return true;
  };

  /** Say what the tree is waiting on, publishing only when that changes: this runs on a timer. */
  const wait = (on: string): void => {
    if (waitingOn === on) return;
    waitingOn = on;
    publish();
  };

  /** Restart into a whole tree once it, and the panel beside it, have stopped moving. */
  const settle = (now: number, panel: PanelActivity | null): void => {
    if (now - lastChangeAt < quietMs) return wait("waiting for edits to settle");
    if (panel?.blocked) return wait(`waiting for the panel: ${panel.blocked}`);
    if (panel && now - panel.changedAt < quietMs) return wait("waiting for the panel's edits to settle");
    take(pendingReason);
  };

  return {
    state,

    /**
     * One debounced batch of writes, each already parsed, and why the tree after them will not link
     * (null, the default, when it does). `now` is when the batch was judged, for the quiet window,
     * and `panel` what the panel's dev server last said: null when there is none to wait for.
     */
    changed(
      changes: ParsedChange[],
      linkFailure: string | null = null,
      now = 0,
      panel: PanelActivity | null = null,
    ): void {
      if (changes.length === 0) return;
      dirty = true;
      lastChangeAt = now;
      waitingOn = null;
      for (const { path, failure } of changes) {
        if (failure === null) broken.delete(path);
        else broken.set(path, failure);
      }
      unlinked = linkFailure;
      if (broken.size > 0 || unlinked !== null) {
        // Said every batch rather than once, because whoever reads this log is looking backwards
        // from a sidecar that stopped changing, and needs to see it was refusing the whole time.
        io.log(`holding the tree back: ${state().blocked}`);
        publish();
        return;
      }
      if (mode === "manual") {
        // Nothing is wrong with the tree. The reader is what it is waiting for, and the running
        // sidecar keeps serving until they say so.
        io.log("the tree parses; waiting to be asked before replacing the sidecar");
        publish();
        return;
      }
      const n = changes.length;
      pendingReason = n === 1 ? "1 changed file parses" : `${n} changed files parse`;
      settle(now, panel);
    },

    /** Ask again whether a whole tree has waited long enough. The supervisor calls this on a timer. */
    tick(now: number, panel: PanelActivity | null): void {
      if (mode !== "auto" || !dirty || broken.size > 0 || unlinked !== null) return;
      settle(now, panel);
    },

    /** Take the tree now, staying in whichever mode the reader chose. */
    apply(): boolean {
      return take("asked for from the panel");
    },

    /** Choose whether a tree that parses is taken as soon as it lands. */
    setMode(next: SupervisorMode): void {
      if (next === mode) return;
      mode = next;
      io.log(`live updates ${next}`);
      // Coming back to auto is itself the yes the tree was waiting for.
      if (next === "auto" && take("live updates back on, and the tree parses")) return;
      publish();
    },
  };
}

/** The file's own name: the log line and the panel row both have one line to spend. */
function base(path: string): string {
  return path.split("/").pop() || path;
}
