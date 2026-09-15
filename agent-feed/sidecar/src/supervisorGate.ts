// When the sidecar is worth restarting, and when a change should be sat on.
//
// The live sidecar arm runs the WORKING TREE, so a file saved halfway through an edit is the file
// that runs. Under `bun --watch` it re-read on every save, and a save mid-edit threw during the
// reload: measured on this repo, that leaves the process alive with its port free, so every stream
// the panel holds dies at once and nothing notices until the host's port probe gives up a minute
// later. The panel keeps rendering the whole time with no data behind it.
//
// So a change no longer restarts anything by itself. A typechecker running in watch mode is both
// the watcher and the judge -- one opinion about the tree rather than two racing ones -- and the
// sidecar is replaced only when that opinion is clean. Same idea as the panel's publish gate
// (`packages/AgentPanel/Web/src/app/dev-server/panelPublish.ts`) and deliberately a separate copy:
// the two trees share only the wire contract, which is types.

/** `src/server.ts(12,3): error TS2304: Cannot find name 'foo'.` under `--pretty false`. */
const TYPECHECK_ERROR = /^(\S.*?\(\d+,\d+\)): (error TS\d+: .*)$/;

/** tsc's own end-of-run line, whatever timestamp prefix it carries. */
const TYPECHECK_DONE = /Found (\d+) error/;

/** tsc says one of these on the first run and at the start of every incremental one. */
const TYPECHECK_STARTED = /(Starting compilation in watch mode|File change detected)/;

export interface SupervisorGateIO {
  /**
   * Replace the running sidecar with one reading the tree as it is now.
   *
   * The caller waits a moment before acting on this, because a green verdict is about the tree as
   * the run began and a save can land mid-run. `abortRestart` is what a later change uses to take
   * it back.
   */
  restart(reason: string): void;
  /** A change arrived; whatever restart was pending was decided about an older tree. */
  abortRestart(): void;
  /** Anything a reader going backwards through the log needs: this is the only record. */
  log(message: string): void;
}

export interface SupervisorState {
  /** True when the tree has moved since the running sidecar was started. */
  dirty: boolean;
  /** True while the typechecker is deciding. */
  checking: boolean;
  /** The first thing the typechecker objected to, or null when it has none. */
  blocked: string | null;
}

export function createSupervisorGate(io: SupervisorGateIO) {
  let dirty = false;
  let checking = false;
  let blocked: string | null = null;

  return {
    state: (): SupervisorState => ({ dirty, checking, blocked }),

    /** One line of the typechecker's watch output, which is the only input this has. */
    readTypecheckLine(line: string): void {
      if (TYPECHECK_STARTED.test(line)) {
        // The first run is a compilation of a tree nobody has edited, so it is not a change. Every
        // later one is: tsc only starts again because a file was written.
        if (!/Starting compilation in watch mode/.test(line)) dirty = true;
        checking = true;
        blocked = null;
        io.abortRestart();
        return;
      }
      const failure = TYPECHECK_ERROR.exec(line);
      // The first error of the run: a later one is usually the same mistake seen from another file.
      if (failure && blocked === null) {
        blocked = `${failure[1] ?? ""}: ${failure[2] ?? ""}`;
        return;
      }
      const done = TYPECHECK_DONE.exec(line);
      if (!done) return;
      checking = false;
      if (done[1] !== "0") {
        blocked ??= `${done[1]} typecheck errors`;
        // Said every round rather than once, because whoever reads this log is looking backwards
        // from a sidecar that stopped changing, and needs to see it was refusing the whole time.
        io.log(`holding the tree back: ${blocked}`);
        return;
      }
      blocked = null;
      if (!dirty) return;
      dirty = false;
      io.restart("the tree typechecks");
    },

    /** Restart now, whatever the typechecker thinks. */
    force(reason: string): void {
      dirty = false;
      blocked = null;
      io.restart(reason);
    },
  };
}
