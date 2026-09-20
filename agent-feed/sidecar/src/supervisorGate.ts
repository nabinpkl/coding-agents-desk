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
// Parsed rather than typechecked. The first version of this ran `tsc --noEmit --watch` as the
// watcher and the judge, which cost 844MB at its peak here, measured with `footprint`. It was also
// the wrong instrument: bun strips types and never checks them, so a type error cannot break a
// running sidecar and was never what broke one. Half a file is. `just check` still catches types.

import type { SupervisorMode } from "@agentdesk/agent-feed-wire";

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

export function createSupervisorGate(io: SupervisorGateIO) {
  /** Files that have changed since the running sidecar started, and will not parse. */
  const broken = new Map<string, string>();
  /** True once anything has changed at all, so an unchanged tree is never restarted into. */
  let dirty = false;
  /** Auto until the panel says otherwise, and again whenever this process starts. */
  let mode: SupervisorMode = "auto";

  const state = (): SupervisorState => {
    const first = [...broken.entries()][0];
    return { held: dirty, blocked: first ? `${base(first[0])}: ${first[1]}` : null, mode };
  };

  const publish = () => io.publish(state());

  /** Take the tree as it stands, if there is one to take and nothing in it is half a file. */
  const take = (reason: string): boolean => {
    if (!dirty || broken.size > 0) return false;
    dirty = false;
    publish();
    io.restart(reason);
    return true;
  };

  return {
    state,

    /** One debounced batch of writes, each already parsed. */
    changed(changes: ParsedChange[]): void {
      if (changes.length === 0) return;
      dirty = true;
      for (const { path, failure } of changes) {
        if (failure === null) broken.delete(path);
        else broken.set(path, failure);
      }
      if (broken.size > 0) {
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
      dirty = false;
      publish();
      const n = changes.length;
      io.restart(n === 1 ? "1 changed file parses" : `${n} changed files parse`);
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
