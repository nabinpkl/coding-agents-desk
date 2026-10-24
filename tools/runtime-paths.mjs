import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

function absoluteEnvironmentPath(environment, name, fallback) {
  const value = environment[name]?.trim() || fallback;
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

/** Shared by build/deployment recipes and the live or compiled TypeScript sidecar. */
export function runtimePaths(environment = process.env, homeDirectory = homedir()) {
  const root = absoluteEnvironmentPath(environment, "AGENTDESK_RUNTIME_ROOT",
    join(homeDirectory, "Library", "Application Support", "AgentDeskRuntime"));
  return {
    root,
    gridEncoder: absoluteEnvironmentPath(environment, "AGENT_FEED_GRID_ENCODER_PATH",
      join(root, "bin", "grid-encoder")),
    // Per-encoder copies of the helper; see agent-feed/sidecar/src/desktop/encoderSlots.ts for why
    // two encoders must never run from one executable path. Per user, not shared: two sidecars
    // refreshing one copy would race each other.
    gridEncoderSlots: join(root, "bin", "grid-encoder-slots"),
    panelTlsDirectory: join(root, "agent-panel", "tls"),
    // The speech process's voice (`agent-feed/speech/speech_server.py`): Phonon 31M English and its
    // everyday English voices, with a SOURCE.txt naming where they came from, put there by
    // `just speech-voice`. Model files are not checked in, so they live with the other things a
    // machine holds for this one.
    speechModels: absoluteEnvironmentPath(environment, "AGENTDESK_SPEECH_MODELS",
      join(root, "speech", "phonon-31m-en")),
    // Whether the reader last asked for edits to be applied as they land, or held until they say.
    // Durable rather than in the dev server's memory, because a dev server restart is one of the
    // things a reader is asking to be protected from when they choose to hold them.
    panelPublishMode: join(root, "agent-panel", "publish-mode.json"),
    // The rendezvous board every sidecar announces itself on. Fixed under /Users/Shared, NOT the
    // per-user runtime root, because a panel in one login session has to read descriptors written
    // by a sidecar in another, and ~/Library is 0700. /Users/Shared is the one place every session
    // can write. Overridable so a test can point it at a scratch dir.
    sidecarRegistry: absoluteEnvironmentPath(environment, "AGENTDESK_SIDECAR_REGISTRY",
      "/Users/Shared/agentdesk/sidecars"),
    // One diagnostics log per login session, named after the user. A single fixed path belongs to
    // whichever session created it first, and every later session's appends fail on permissions --
    // silently, since diagnostics must never take the media path down. That is not a cosmetic loss:
    // it is the session running blind while its own numbers are read off another session's file.
    // Beside the registry, and for the same reason: evidence written by one session has to be
    // readable from another, and ~/Library is 0700.
    webrtcDiagLog: absoluteEnvironmentPath(environment, "AGENTDESK_WEBRTC_DIAG_LOG",
      join("/Users/Shared/agentdesk/logs", `${userInfo().username}-webrtc-diag.log`)),
    // Every telemetry envelope the panel and this sidecar produced, as size-capped segment files
    // (`agent-feed/sidecar/src/telemetry/`). Beside the other logs for the same reasons.
    telemetryArchive: absoluteEnvironmentPath(environment, "AGENTDESK_TELEMETRY_ARCHIVE",
      join("/Users/Shared/agentdesk/logs", `${userInfo().username}-telemetry`)),
    // The personal strings `tools/public-scan/` keeps out of the tree: names, addresses, account
    // ids. Outside the checkout on purpose, because a list of them committed to the repository
    // would publish exactly what it exists to keep private. One file per machine, shared by every
    // checkout and worktree on it.
    publicScanDenylist: absoluteEnvironmentPath(environment, "AGENTDESK_PUBLIC_SCAN_DENYLIST",
      join(root, "public-scan", "denylist")),
  };
}

export function installedHostAppPath(bundleId, paths = runtimePaths()) {
  if (typeof bundleId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(bundleId)) {
    throw new Error("host bundle id must contain only letters, digits, dots, and hyphens");
  }
  return join(paths.root, "hosts", bundleId, "AgentDeskHost.app");
}

if (import.meta.main) {
  const [key, bundleId, ...extra] = process.argv.slice(2);
  const paths = runtimePaths();
  const named = {
    root: paths.root,
    "grid-encoder": paths.gridEncoder,
    "grid-encoder-slots": paths.gridEncoderSlots,
    "panel-tls": paths.panelTlsDirectory,
    "speech-models": paths.speechModels,
    "sidecar-registry": paths.sidecarRegistry,
    "webrtc-diag-log": paths.webrtcDiagLog,
    "telemetry-archive": paths.telemetryArchive,
    "public-scan-denylist": paths.publicScanDenylist,
  };
  if (key === "host-app" && bundleId && extra.length === 0) {
    process.stdout.write(`${installedHostAppPath(bundleId, paths)}\n`);
  } else if (Object.hasOwn(named, key) && bundleId === undefined) {
    process.stdout.write(`${named[key]}\n`);
  } else {
    throw new Error("usage: runtime-paths.mjs root|grid-encoder|grid-encoder-slots|panel-tls|speech-models|sidecar-registry|webrtc-diag-log|telemetry-archive|public-scan-denylist|host-app <bundle-id>");
  }
}
