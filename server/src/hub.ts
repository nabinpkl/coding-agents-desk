/* Talking to the agent hub at relay.example.com.
 *
 * The hub sits behind its own Cloudflare Access app, so calling it means presenting an Access
 * service token: exchange the client id and secret for a short-lived JWT at the team's token
 * endpoint, then send that as `cf-access-jwt-assertion`. There is no other credential: the hub's
 * principals table decides what the token may do, and this one may only send as `human`.
 *
 * This module is the only place that knows any of that. The service depends on the `HubClient`
 * interface, so a test can hand it a fake and no test needs an edge.
 */
import type { Recipient, SendState } from "../../shared/send.ts";

/** The hub is there but would not take the message: a stale address, a full thread, a hop limit. */
export class HubRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubRefused";
  }
}

/** The hub could not be reached, or answered with a failure that is ours to fix, not the reader's. */
export class HubUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubUnreachable";
  }
}

export interface HubMessage {
  id: string;
  to: string;
  state: SendState;
}

export interface HubClient {
  /** Everything addressable right now: sessions, the Bots they belong to, and `human`. */
  directory(): Promise<Recipient[]>;
  /** Posts one request as `human`, carrying refs back to the annotations it speaks for. */
  send(input: { to: string; body: string; refs: Array<{ app: string; kind: string; id: string; url?: string }> }): Promise<HubMessage>;
  /** The live state of one message, for the per-annotation delivery readout. */
  message(id: string): Promise<Pick<HubMessage, "state">>;
}

export interface HubConfig {
  url: string;
  /** Cloudflare Access service token for the hub's Access app. */
  accessClientId: string;
  accessClientSecret: string;
  /** Where that token is exchanged for a JWT. Same team as this server's own Access app. */
  accessTokenUrl: string;
}

/** Refresh this long before the JWT expires, so a request never leaves with one about to die. */
const TOKEN_MARGIN_MS = 60_000;

function hubError(status: number, body: unknown, path: string): Error {
  const detail = typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `HTTP ${status}`;
  if (status === 401 || status === 403) {
    // Never the secret, and never the assertion: name the credential so the log says which one.
    return new HubUnreachable(`hub refused this server's Access service token on ${path} (${detail})`);
  }
  if (status === 404 || status === 409 || status === 400 || status === 422 || status === 429) return new HubRefused(detail);
  return new HubUnreachable(`hub ${path} failed: ${detail}`);
}

export function createHubClient(config: HubConfig, fetchImpl: typeof fetch = fetch): HubClient {
  let cached: { token: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  /**
   * The Access JWT, fetched once and reused until it is nearly expired.
   *
   * Single-flight, because the panel asks for the recipient list and the send states at the same
   * time, and two simultaneous exchanges would burn two tokens to learn the same thing.
   */
  async function assertion(): Promise<string> {
    const now = Date.now();
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > now) return cached.token;
    inFlight ??= (async () => {
      let res: Response;
      try {
        res = await fetchImpl(config.accessTokenUrl, {
          method: "POST",
          headers: { "cf-access-client-id": config.accessClientId, "cf-access-client-secret": config.accessClientSecret },
        });
      } catch (e) {
        throw new HubUnreachable(`could not reach the Access token endpoint: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) throw new HubUnreachable(`Access token endpoint answered HTTP ${res.status}`);
      const body = (await res.json()) as { token?: unknown; expires_in?: unknown };
      if (typeof body.token !== "string" || typeof body.expires_in !== "number") throw new HubUnreachable("Access token endpoint returned no token");
      cached = { token: body.token, expiresAt: Date.now() + body.expires_in * 1000 };
      return body.token;
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const token = await assertion();
    let res: Response;
    try {
      res = await fetchImpl(`${config.url}${path}`, {
        method,
        headers: {
          "cf-access-jwt-assertion": token,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new HubUnreachable(`could not reach the hub: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) throw hubError(res.status, parsed, path);
    return parsed;
  }

  function asRecipient(entry: unknown): Recipient | null {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.address !== "string" || typeof e.name !== "string") return null;
    return {
      address: e.address,
      name: e.name,
      machine: typeof e.machine === "string" ? e.machine : null,
      cwd: typeof e.cwd === "string" ? e.cwd : null,
      // The hub's own vocabulary is richer than the panel needs; anything it has not seen is offline.
      reachability: e.reachability === "reachable" ? "reachable" : "offline",
      lastSeenAt: typeof e.lastSeenAt === "string" ? e.lastSeenAt : null,
      related: Array.isArray(e.related) ? e.related.filter((a): a is string => typeof a === "string") : [],
    };
  }

  return {
    async directory() {
      const body = await call("GET", "/v1/directory");
      if (!Array.isArray(body)) throw new HubUnreachable("hub directory was not a list");
      return body.map(asRecipient).filter((r): r is Recipient => r !== null);
    },

    async send({ to, body, refs }) {
      const out = await call("POST", "/v1/messages", { as: "human", to, kind: "request", body, refs });
      const m = (out ?? {}) as Record<string, unknown>;
      if (typeof m.id !== "string") throw new HubUnreachable("hub accepted the message but returned no id");
      return { id: m.id, to, state: (typeof m.state === "string" ? m.state : "queued") as SendState };
    },

    async message(id) {
      const out = (await call("GET", `/v1/messages/${encodeURIComponent(id)}`)) as Record<string, unknown>;
      return { state: (typeof out?.state === "string" ? out.state : "queued") as SendState };
    },
  };
}
