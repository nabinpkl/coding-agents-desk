// The address the sidecar binds, and the host names a request may arrive under.
//
// Split out of `config.ts` for the reason every sibling here exists: one idea per file, and
// "who may address this server" is an idea of its own. Imported by `config.ts`, and by the small
// processes a session starts that must reach the sidecar without loading all of its config.

import { integerEnvironment } from "@/config/configEnvironment";

/** Where the server listens. Loopback unless a peer binds its tailnet address. */
export const bindHost = process.env.AGENT_FEED_HOST ?? "127.0.0.1";

/** The port it listens on. */
export const bindPort = integerEnvironment("AGENT_FEED_PORT", 7682, 1, 65_535);

/**
 * How a process on this machine reaches the sidecar: the bind address, or loopback where it binds
 * every interface. A session's tool process does not inherit the sidecar's environment, so it
 * reaches the default unless the session was given the same `AGENT_FEED_PORT`.
 */
const reachableHost = bindHost === "0.0.0.0" || bindHost === "::" ? "127.0.0.1" : bindHost;
export const localOrigin = `http://${reachableHost.includes(":") ? `[${reachableHost}]` : reachableHost}:${bindPort}`;

/**
 * Names a request may arrive under, without the port (`http/requestGuard.ts` refuses any
 * other). Loopback and the bind address always, since those are how the host's own clients and
 * the panel's proxy address it; `AGENT_FEED_ALLOWED_HOSTS`, comma separated, adds a name such
 * as a tailnet front. A new way of reaching the sidecar is a new entry here, never a removed
 * check.
 */
export const allowedHosts: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "localhost",
  bindHost,
  ...(process.env.AGENT_FEED_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== ""),
]);
