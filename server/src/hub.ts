/* Talking to the agent hub at relay.example.com.
 *
 * The hub sits behind Cloudflare Access, and Access takes a service token's client id and secret
 * as headers on the request itself: the edge does the token exchange, and the origin sees only
 * the assertion that results. So there is nothing to mint, cache, or refresh here. (There is a
 * `/cdn-cgi/access/token` endpoint for minting an assertion by hand, and it is not what this
 * setup serves: it answers 404, which is how this file learned that.)
 *
 * What the credential is allowed to do is not Cloudflare's decision. It is the hub's principals
 * table, which resolves the client id to a principal; this one may send as `human` and speaks for
 * no machine.
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
}

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
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(`${config.url}${path}`, {
        method,
        headers: {
          "cf-access-client-id": config.accessClientId,
          "cf-access-client-secret": config.accessClientSecret,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Access answers an unusable service token with a redirect to its login page rather than a
        // status code, and following it would hand this server an HTML page where JSON belongs.
        redirect: "manual",
      });
    } catch (e) {
      throw new HubUnreachable(`could not reach the hub: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    // The redirect case first, because its body is a sign-in page and says nothing useful.
    if (res.status >= 300 && res.status < 400) {
      throw new HubUnreachable(`hub redirected ${path} to a sign-in page: Access refused this server's service token`);
    }
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
