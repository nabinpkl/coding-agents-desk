/**
 * Which sidecars the panel's dev server can offer, from the two places they come from.
 *
 * Sessions on this machine ANNOUNCE: each sidecar writes a heartbeat descriptor onto a shared board
 * and the reader ages it out when the heartbeat stops (`announceSidecar`). A sidecar on another
 * machine cannot do that -- the board is a directory on this one -- so a remote peer is DECLARED
 * instead, and its liveness comes from the reader reaching it rather than from a file it wrote.
 *
 * Both kinds end up as the same entry, so nothing downstream has to know which it is looking at.
 *
 * This module is the pure half, extracted so it can be tested: the plugin that uses it lives in
 * `vite.config.ts`, which has no tests, and "which peers are live" is exactly the logic that fails
 * quietly -- an entry that never appears and an entry that never leaves look identical from the
 * picker.
 */

/** Ids become a path segment, so anything that could reshape the path is refused. */
const ID = /^[a-z0-9-]+$/i;

/**
 * A sidecar the dev server is willing to proxy to.
 *
 * `host` is loopback for a board peer and the peer's address for a declared one. It is carried
 * rather than assumed because the proxy used to hardcode `127.0.0.1`, which silently made every
 * declared peer resolve to the reader's own machine.
 */
export interface LiveSidecar {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
}

/** A declared peer, before anything has checked whether it answers. */
export interface DeclaredPeer {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
}

/** A descriptor older than this has lost its heartbeat; the sidecar behind it is treated as gone. */
export const SIDECAR_STALE_MS = 15_000;

/**
 * One board descriptor, or null when it is unusable.
 *
 * `host` is optional on the way in: a descriptor written by an older sidecar does not carry one,
 * and defaulting it to loopback is right for every board peer by definition.
 */
export function parseDescriptor(raw: unknown, now: number): LiveSidecar | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { user, port, heartbeat, host, label } = raw as Record<string, unknown>;
  if (typeof user !== "string" || !ID.test(user)) return null;
  if (typeof port !== "number" || !Number.isInteger(port)) return null;
  if (typeof heartbeat !== "number" || now - heartbeat > SIDECAR_STALE_MS) return null;
  return {
    id: user,
    label: typeof label === "string" && label ? label : user,
    host: typeof host === "string" && host ? host : "127.0.0.1",
    port,
  };
}

/**
 * Declared peers, from one env value: `id=host:port`, comma separated, label defaulting to the id.
 *
 * Env rather than a checked-in list because an address is environment-dependent, and one string
 * rather than a file because the dev server already takes its own sidecar's origin that way. A
 * malformed entry is dropped rather than throwing: a typo in one peer should not stop the server
 * that serves the local session.
 */
export function parseDeclaredPeers(spec: string | undefined): DeclaredPeer[] {
  if (!spec) return [];
  const peers: DeclaredPeer[] = [];
  const seen = new Set<string>();
  for (const chunk of spec.split(",")) {
    const entry = chunk.trim();
    if (!entry) continue;
    const equals = entry.indexOf("=");
    if (equals <= 0) continue;
    const id = entry.slice(0, equals).trim();
    if (!ID.test(id) || seen.has(id)) continue;
    const address = entry.slice(equals + 1).trim();
    const colon = address.lastIndexOf(":");
    if (colon <= 0) continue;
    const host = address.slice(0, colon).trim();
    const port = Number(address.slice(colon + 1).trim());
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) continue;
    seen.add(id);
    peers.push({ id, label: id, host, port });
  }
  return peers;
}

/**
 * The live set: board peers, plus declared peers last seen answering recently enough.
 *
 * A board peer wins a name collision, because a session actually running on this machine is the
 * more specific answer and the one whose port is certain to be current.
 */
export function mergeSidecars(
  board: LiveSidecar[],
  declared: DeclaredPeer[],
  reachableAt: ReadonlyMap<string, number>,
  now: number,
): Map<string, LiveSidecar> {
  const live = new Map<string, LiveSidecar>();
  for (const peer of declared) {
    const seen = reachableAt.get(peer.id);
    if (seen === undefined || now - seen > SIDECAR_STALE_MS) continue;
    live.set(peer.id, { id: peer.id, label: peer.label, host: peer.host, port: peer.port });
  }
  for (const entry of board) live.set(entry.id, entry);
  return live;
}

/**
 * What the picker shows: the running account's own session first, then everyone else by label.
 *
 * The default session carries no id because it answers on `/api`, which is what the host's relay
 * and every existing caller already speak. Sorting the rest keeps the picker order from jumping
 * between reads.
 */
export function indexFor(live: ReadonlyMap<string, LiveSidecar>, self: string): { id?: string; label: string }[] {
  const others = [...live.values()]
    .filter((entry) => entry.id !== self)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((entry) => ({ id: entry.id, label: entry.label }));
  return [{ label: live.get(self)?.label ?? self }, ...others];
}
