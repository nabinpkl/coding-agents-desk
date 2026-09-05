import { homedir } from "node:os";
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
    panelTlsDirectory: join(root, "agent-panel", "tls"),
    panelControlTokenFile: join(root, "agent-panel", "control-token"),
    parkDevControlTokenFile: join(root, "park-dev", "control-token"),
    // The rendezvous board every sidecar announces itself on. Fixed under /Users/Shared, NOT the
    // per-user runtime root, because a panel in one login session has to read descriptors written
    // by a sidecar in another, and ~/Library is 0700. /Users/Shared is the one place every session
    // can write. Overridable so a test can point it at a scratch dir.
    sidecarRegistry: absoluteEnvironmentPath(environment, "AGENTDESK_SIDECAR_REGISTRY",
      "/Users/Shared/agentdesk/sidecars"),
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
    "panel-tls": paths.panelTlsDirectory,
    "panel-token": paths.panelControlTokenFile,
    "park-token": paths.parkDevControlTokenFile,
    "sidecar-registry": paths.sidecarRegistry,
  };
  if (key === "host-app" && bundleId && extra.length === 0) {
    process.stdout.write(`${installedHostAppPath(bundleId, paths)}\n`);
  } else if (Object.hasOwn(named, key) && bundleId === undefined) {
    process.stdout.write(`${named[key]}\n`);
  } else {
    throw new Error("usage: runtime-paths.mjs root|grid-encoder|panel-tls|panel-token|park-token|sidecar-registry|host-app <bundle-id>");
  }
}
