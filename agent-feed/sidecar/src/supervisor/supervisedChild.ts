// One process the supervisor keeps running: the sidecar, the audio process and the speech process
// beside it.
//
// Started from the command it is given (this Bun and an entry file, or the speech process's Python),
// restarted after a backoff when it exits on its own, and replaced when the supervisor decides its
// code moved. Its output goes to the supervisor's, which the host already writes to the sidecar's
// log, so every child's lines land in one file.

import { stopChild } from "@/supervisor/supervisorStop";

/** After a child that died on its own, so a crash loop does not spin the machine. */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000];

/** Long enough to count as "it ran", which is what resets the backoff. */
const SETTLED_MS = 10_000;

export type SupervisedChild = {
  start(): void;
  /** Stops it and starts it again; starts it if nothing is running. */
  replace(reason: string): void;
  /** Stops it for good, resolving once it has exited. */
  stop(): Promise<unknown>;
};

export function superviseChild(
  name: string,
  command: readonly string[],
  log: (message: string) => void,
): SupervisedChild {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  /** Set while a restart is deliberate, so the exit it causes is not read as a crash. */
  let replacing = false;
  let crashes = 0;
  let stopping = false;

  function start(): void {
    const startedAt = Date.now();
    // stdio inherited: the host is already reading the supervisor's output into the sidecar's log,
    // and a second copy through here would only add a layer that can drop lines.
    const spawned = Bun.spawn({
      cmd: [...command],
      stdio: ["ignore", "inherit", "inherit"],
    });
    child = spawned;
    log(`${name} started, pid ${spawned.pid}`);

    void spawned.exited.then((code) => {
      if (child !== spawned) return;
      child = undefined;
      if (stopping) return;
      if (replacing) {
        replacing = false;
        start();
        return;
      }
      // Nobody asked for this. A child that exits on its own has either crashed or been killed by
      // hand, and both want it back.
      if (Date.now() - startedAt > SETTLED_MS) crashes = 0;
      const wait = BACKOFF_MS[Math.min(crashes, BACKOFF_MS.length - 1)] ?? 10_000;
      crashes += 1;
      log(`${name} exited with ${code}; starting it again in ${wait}ms`);
      setTimeout(() => {
        if (!stopping && !child) start();
      }, wait);
    });
  }

  return {
    start,
    replace(reason) {
      if (!child) {
        log(`${reason}; nothing running, starting the ${name}`);
        start();
        return;
      }
      log(`${reason}; replacing the ${name}`);
      replacing = true;
      // SIGTERM first: the child closes its listeners and lets go of its port, which is what the
      // next one needs in the half-second before it binds. SIGKILL only if it cannot, or the
      // replacement would wait on its exit forever.
      stopChild(child, log);
    },
    stop() {
      stopping = true;
      if (!child) return Promise.resolve();
      stopChild(child, log);
      return child.exited;
    },
  };
}
