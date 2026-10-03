// The address the sidecar binds, and the host names a request may arrive under.
//
// Split out of `config.ts` for the reason every sibling here exists: one idea per file, and
// "who may address this server" is an idea of its own. Imported by `config.ts`, never by
// callers directly.

/** Where the server listens. Loopback unless a peer binds its tailnet address. */
export const bindHost = process.env.AGENT_FEED_HOST ?? "127.0.0.1";

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
