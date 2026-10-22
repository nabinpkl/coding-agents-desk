// The supervisor's third child: the speech process (`agent-feed/speech/speech_server.py`), Python
// holding Phonon on the Mac's GPU, which the sidecar sends a Bot session's announcements to.
//
// Its own Python environment, and its voice from the runtime root, both put in place by
// `just speech-voice`, which pins its packages and the voice's files. One source file and no
// imports of ours, so that file changing is the one thing that replaces it. Not judged by the supervisor's gate: Bun cannot parse Python, and a
// file that will not run fails at once and is started again on the crash backoff.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { runtimePaths } from "@repo/tools/runtime-paths.mjs";
import { sidecarPort, speechPort } from "@/audio/audioConfig";
import { superviseChild } from "@/supervisor/supervisedChild";
import { watchTree } from "@/transcripts/catalog/watchTree";

/** How often the sidecar is asked whether it is live, and for how long, before the speech process starts. */
const SIDECAR_LIVE_POLL_MS = 500;
const SIDECAR_LIVE_WAIT_MS = 120_000;

export type SpeechProcessOptions = {
  /** The `agent-feed` directory, which holds `speech/`. */
  agentFeed: string;
  log: (message: string) => void;
  /** True once the supervisor is on its way out: nothing more is started. */
  stopping: () => boolean;
  /** How long the file's writes are collected before it is replaced, as for the tree. */
  settleMs: number;
};

export function createSpeechProcess({ agentFeed, log, stopping, settleMs }: SpeechProcessOptions) {
  const directory = join(agentFeed, "speech");
  const server = join(directory, "speech_server.py");
  const python = join(directory, ".venv", "bin", "python");
  const models = runtimePaths().speechModels;
  const child = superviseChild(
    "speech process",
    // -u: unbuffered, so its lines reach the log as they are said rather than in blocks.
    [python, "-u", server, "--port", String(speechPort()), "--models", models],
    log,
  );
  let settle: ReturnType<typeof setTimeout> | undefined;

  /** Starts it, or says what it is missing: a machine without it still runs the rest. */
  function start(): void {
    const missing = [python, join(models, "model.safetensors")].find((path) => !existsSync(path));
    if (missing) {
      log(`not starting the speech process: ${missing} is not there (\`just speech-voice\` puts both in place)`);
      return;
    }
    child.start();
  }

  return {
    server,

    /**
     * Starts it once the sidecar answers as live, the way the host judges it (`/api/config` saying
     * `watcherState: "live"`). The host gives a new supervisor's sidecar five seconds to get there
     * and kills it otherwise, and on this Mac Python loading the voice beside it pushed it past
     * that: measured 2026-10-20, every start failed until the speech process was left out.
     *
     * A poll, justified: the sidecar is another process that announces its readiness to nobody, and
     * this asks it the same question the host does. It stops at the first live answer.
     */
    async startOnceSidecarIsLive(): Promise<void> {
      const config = `http://127.0.0.1:${sidecarPort()}/api/config`;
      const deadline = Date.now() + SIDECAR_LIVE_WAIT_MS;
      while (!stopping() && Date.now() < deadline) {
        try {
          const response = await fetch(config, { signal: AbortSignal.timeout(1_000) });
          const body = (await response.json()) as { watcherState?: unknown };
          if (response.ok && body.watcherState === "live") break;
        } catch {
          // Not listening yet, or not answering in time: asked again below.
        }
        await Bun.sleep(SIDECAR_LIVE_POLL_MS);
      }
      if (stopping()) return;
      if (Date.now() >= deadline) {
        log(`the sidecar was not live within ${SIDECAR_LIVE_WAIT_MS / 1000}s; starting the speech process anyway`);
      }
      start();
    },

    /** Replaces it once its file has settled. One watch, never closed, as for the tree. */
    watch(): void {
      watchTree({
        root: directory,
        depth: 0,
        onPath: (path) => {
          if (path !== server || stopping()) return;
          clearTimeout(settle);
          settle = setTimeout(() => child.replace("speech_server.py changed"), settleMs);
        },
        onError: (error) => log(`watcher error under ${directory}: ${String(error)}`),
      });
    },

    /** Stops it for good, resolving once it has exited. */
    stop(): Promise<unknown> {
      clearTimeout(settle);
      return child.stop();
    },
  };
}
