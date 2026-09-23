import { config } from "@/config/config";
import { frames, KIND_META } from "@/http/tile-encoder/encoderFrames";
import { helperBinary, type HelperBinary, missingHelperMessage } from "@/desktop/helperBinary";

/**
 * The sidecar's end of `grid-encoder --control`.
 *
 * One resident helper for the whole process, because an `AXObserver` only delivers while its own
 * process runs a run loop: a helper spawned per request could read and write a composer but could
 * never watch one, which would quietly turn event-driven composer sync back into polling.
 *
 * One helper is also what keeps window moves serialized. The host kept a single composer
 * coordinator for exactly this reason -- two of them could move the same Claude window at once and
 * each would restore it to a home Desktop the other had already changed -- and that argument
 * survives the move to TypeScript unchanged.
 *
 * The helper is respawned, never reused, when the binary underneath it changes. See `helperBinary`.
 */

const KIND_CONTROL = 4;

/** What the helper answers with. `reason` is a `WindowInputReason` code, never prose. */
export class ControlHelperError extends Error {
  constructor(readonly reason: string) {
    super(`helper request failed: ${reason}`);
    this.name = "ControlHelperError";
  }
}

export interface HelperProcess {
  /** Newline-delimited JSON in. */
  write(line: string): void;
  /** `{kind, payload}` out, control and meta frames alike. */
  frames: AsyncGenerator<{ kind: number; payload: Uint8Array }>;
  kill(): void;
}

/** What the helper announced about itself when it opened. */
export interface HelperCapabilities {
  inputTrusted: boolean;
  screenRecordingTrusted: boolean;
  composerVersion: number;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Live {
  process: HelperProcess;
  binaryMtimeMs: number;
  capabilities: Promise<HelperCapabilities>;
  pending: Map<string, Pending>;
  dead: boolean;
}

export interface ControlHelper {
  /** Sends one verb and waits for its reply. Rejects with `ControlHelperError` on a refusal. */
  request(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** What the current helper announced. Spawns one if none is running. */
  capabilities(): Promise<HelperCapabilities>;
  /** Unsolicited events (observer notifications). Returns unsubscribe. */
  onPush(handler: (event: Record<string, unknown>) => void): () => void;
  /** Ends the current helper. The next request spawns a fresh one. */
  stop(): void;
}

export interface ControlHelperOptions {
  timeoutMs?: number;
  /** Where the binary is and which build it is. Injected so tests can move the build stamp. */
  probe?: () => HelperBinary;
  idleSeconds?: number;
}

export function createControlHelper(
  spawn: (path: string, idleSeconds: number) => HelperProcess,
  options: ControlHelperOptions = {},
): ControlHelper {
  const timeoutMs = options.timeoutMs ?? config.desktopHelperRequestTimeoutMs;
  const probe = options.probe ?? helperBinary;
  const idleSeconds = options.idleSeconds ?? config.desktopHelperIdleSeconds;
  let live: Live | null = null;
  let sequence = 0;
  const pushHandlers = new Set<(event: Record<string, unknown>) => void>();

  function retire(current: Live, reason: string) {
    if (current.dead) return;
    current.dead = true;
    if (live === current) live = null;
    for (const [, pending] of current.pending) {
      clearTimeout(pending.timer);
      pending.reject(new ControlHelperError(reason));
    }
    current.pending.clear();
    current.process.kill();
  }

  function start(): Live {
    const { path, mtimeMs, exists } = probe();
    if (!exists) throw new ControlHelperError(missingHelperMessage(path));

    const process = spawn(path, idleSeconds);
    let resolveCapabilities!: (value: HelperCapabilities) => void;
    let rejectCapabilities!: (error: Error) => void;
    const capabilities = new Promise<HelperCapabilities>((resolve, reject) => {
      resolveCapabilities = resolve;
      rejectCapabilities = reject;
    });
    // Nothing awaits this until the first caller does, and an unhandled rejection in Bun is a
    // process-level complaint about a failure that is already reported through `request`.
    capabilities.catch(() => {});

    const current: Live = { process, binaryMtimeMs: mtimeMs, capabilities, pending: new Map(), dead: false };

    void (async () => {
      try {
        for await (const frame of process.frames) {
          let message: Record<string, unknown>;
          try {
            message = JSON.parse(new TextDecoder().decode(frame.payload)) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (frame.kind === KIND_META) {
            if (message.type === "open") {
              resolveCapabilities({
                inputTrusted: message.inputTrusted === true,
                screenRecordingTrusted: message.screenRecordingTrusted === true,
                composerVersion: typeof message.composerVersion === "number" ? message.composerVersion : 0,
              });
            }
            continue;
          }
          if (frame.kind !== KIND_CONTROL) continue;
          const rid = typeof message.rid === "string" ? message.rid : null;
          if (message.type !== "result" || rid === null) {
            // No correlation id means nobody asked: an observer notification, not a reply.
            for (const handler of pushHandlers) handler(message);
            continue;
          }
          const pending = current.pending.get(rid);
          if (!pending) continue;
          current.pending.delete(rid);
          clearTimeout(pending.timer);
          if (message.ok === true) {
            pending.resolve((message.value ?? {}) as Record<string, unknown>);
          } else {
            pending.reject(new ControlHelperError(String(message.reason ?? "helper-refused")));
          }
        }
      } finally {
        // The stream ending means the child did. Its idle watchdog does this on purpose after a
        // quiet period, so this is a normal transition and not an error: the next request spawns a
        // replacement. Only requests already in flight fail, and they fail with a reason.
        rejectCapabilities(new ControlHelperError("helper-exited"));
        retire(current, "helper-exited");
      }
    })();

    return current;
  }

  function ensure(): Live {
    // The mtime check is the whole staleness answer. A rebuilt binary is a different helper, and
    // holding the old process would make a seven-second rebuild loop silently ineffective.
    if (live && !live.dead && live.binaryMtimeMs !== probe().mtimeMs) {
      retire(live, "stale-binary");
    }
    if (!live || live.dead) live = start();
    return live;
  }

  return {
    request(type, payload = {}) {
      let current: Live;
      try {
        current = ensure();
      } catch (error) {
        return Promise.reject(error);
      }
      const rid = `r${++sequence}`;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          current.pending.delete(rid);
          reject(new ControlHelperError("helper-timeout"));
        }, timeoutMs);
        current.pending.set(rid, { resolve, reject, timer });
        try {
          current.process.write(`${JSON.stringify({ ...payload, rid, type })}\n`);
        } catch (error) {
          current.pending.delete(rid);
          clearTimeout(timer);
          // A write that throws means the pipe is gone, which the frame loop may not have noticed
          // yet. Retire now so the next request does not queue behind a corpse.
          retire(current, "helper-write-failed");
          reject(error instanceof Error ? error : new ControlHelperError("helper-write-failed"));
        }
      });
    },
    capabilities() {
      try {
        return ensure().capabilities;
      } catch (error) {
        return Promise.reject(error);
      }
    },
    onPush(handler) {
      pushHandlers.add(handler);
      return () => pushHandlers.delete(handler);
    },
    stop() {
      if (live) retire(live, "helper-stopped");
    },
  };
}

function spawnControlHelper(path: string, idleSeconds: number): HelperProcess {
  const child = Bun.spawn([path, "--control", "--idle-seconds", String(idleSeconds)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const encoder = new TextEncoder();
  return {
    write: (line) => {
      child.stdin.write(encoder.encode(line));
      child.stdin.flush();
    },
    frames: frames(child.stdout as ReadableStream<Uint8Array>),
    kill: () => {
      try {
        child.kill();
      } catch {
        // Already gone. Nothing to do and nothing to report.
      }
    },
  };
}

/** The process-wide helper. One, for the reasons in this file's header. */
export const controlHelper = createControlHelper(spawnControlHelper);
