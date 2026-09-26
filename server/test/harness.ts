/* Boots the real HTTP app on an ephemeral port with a temp database and a
 * local JWKS, and mints Access-style JWTs for tests. It also stands up a fake
 * hub edge, so Send runs through the real hub client rather than a stub. */
import { serve } from "@hono/node-server";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Recipient, SendState } from "../../shared/send.ts";
import { createAccessVerifier } from "../src/auth/access-jwt.ts";
import { SendBudget } from "../src/budget.ts";
import { createApp } from "../src/http/app.ts";
import { createHubClient } from "../src/hub.ts";
import { createMcpEndpoint } from "../src/mcp/mcp-endpoint.ts";
import { createAnnotationService } from "../src/service/annotations.ts";
import { openSqliteStore } from "../src/store/sqlite-store.ts";

export const OWNER = "owner@example.com";
export const SERVICE_TOKEN = "svc-e2e.access";
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-test";
/** The fake edge only accepts this token, so a client that sends nothing is caught, not tolerated. */
export const HUB_CLIENT_ID = "annotator-test.access";
export const HUB_CLIENT_SECRET = "annotator-test-secret";

/** What the fake hub recorded and can be told to do next. */
export interface FakeHub {
  url: string;
  /** Every message the hub was asked to post, in order. */
  readonly sent: Array<{ as: unknown; to: unknown; kind: unknown; body: unknown; refs: unknown }>;
  /** Every call that arrived without the right service token. */
  readonly unauthorized: number;
  /** Makes the next hub call answer this status and body, once. */
  failOnce(status: number, body: unknown): void;
  /** Moves a message's state, for the per-annotation readout. */
  setState(messageId: string, state: SendState): void;
}

async function startFakeHub(): Promise<FakeHub & { close(): Promise<void> }> {
  const sent: FakeHub["sent"] = [];
  const states = new Map<string, SendState>();
  const state = { unauthorized: 0, failure: null as { status: number; body: unknown } | null, counter: 0 };
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    // The real edge takes the service token's id and secret as headers on the request and does the
    // exchange itself, so that is all this fake demands. A client that minted its own assertion
    // would pass here and fail against Cloudflare, which is how it went wrong once.
    if (req.headers["cf-access-client-id"] !== HUB_CLIENT_ID || req.headers["cf-access-client-secret"] !== HUB_CLIENT_SECRET) {
      state.unauthorized += 1;
      send(401, { error: "missing or wrong service token" });
      return;
    }
    if (state.failure) {
      const { status, body } = state.failure;
      state.failure = null;
      send(status, body);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = raw ? JSON.parse(raw) : null;
      if (req.url === "/v1/directory") {
        send(200, DIRECTORY);
        return;
      }
      if (req.url === "/v1/messages" && req.method === "POST") {
        const b = body as Record<string, unknown>;
        sent.push({ as: b.as, to: b.to, kind: b.kind, body: b.body, refs: b.refs });
        const id = `hub-msg-${++state.counter}`;
        states.set(id, "queued");
        send(201, { id, to: b.to, state: "queued" });
        return;
      }
      const one = /^\/v1\/messages\/([^/]+)$/.exec(req.url ?? "");
      if (one && req.method === "GET") {
        const id = decodeURIComponent(one[1]!);
        const known = states.get(id);
        if (!known) {
          send(404, { error: `no such message: ${id}` });
          return;
        }
        send(200, { id, state: known });
        return;
      }
      send(404, { error: "not found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    sent,
    get unauthorized() {
      return state.unauthorized;
    },
    failOnce(status, body) {
      state.failure = { status, body };
    },
    setState(messageId, next) {
      states.set(messageId, next);
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * The directory the fake hub serves: the owner, and two Bots over one session each.
 *
 * A session in no Bot is absent, because the hub does not list one and this cannot send to it. Every
 * session row carries the qualified address even under a Bot curating one, so no two rows share an
 * address, and `session` is the field that says which run a row is.
 */
export const DIRECTORY: Recipient[] = [
  { address: "human", session: null, name: "owner", machine: null, cwd: null, reachability: "reachable", lastSeenAt: null, related: [] },
  { address: "bot:site", session: null, name: "Site bot", machine: "mac", cwd: "/work/site", reachability: "reachable", lastSeenAt: null, related: ["bot:site/opencode:ses_1"] },
  { address: "bot:site/opencode:ses_1", session: "opencode:ses_1", name: "Fix the header", machine: "mac", cwd: "/work/site", reachability: "reachable", lastSeenAt: null, related: ["bot:site"] },
  { address: "bot:night", session: null, name: "Night bot", machine: "oracle", cwd: "/home/ubuntu", reachability: "offline", lastSeenAt: null, related: ["bot:night/opencode:ses_2"] },
  { address: "bot:night/opencode:ses_2", session: "opencode:ses_2", name: "Night shift", machine: "oracle", cwd: "/home/ubuntu", reachability: "offline", lastSeenAt: null, related: ["bot:night"] },
];

export interface Harness {
  base: string;
  /** The Hono app itself, for in-process requests that must not touch a socket. */
  app: ReturnType<typeof createApp>;
  token(claims?: Record<string, unknown>): Promise<string>;
  fetch(p: string, init?: RequestInit & { as?: Record<string, unknown> | null }): Promise<Response>;
  logs: Array<Record<string, unknown>>;
  hub: FakeHub;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** A caller-supplied budget, for the tests that want the throttle rather than around it. */
  sendBudget?: SendBudget;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const jwksServer = http.createServer((_q, r) => {
    r.writeHead(200, { "content-type": "application/json" });
    r.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwksServer.listen(0, "127.0.0.1", r));
  const jwksUrl = new URL(`http://127.0.0.1:${(jwksServer.address() as AddressInfo).port}/certs`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "annotator-http-"));
  const store = openSqliteStore(path.join(dir, "annotator.db"));
  const hubEdge = await startFakeHub();
  const service = createAnnotationService(
    store,
    createHubClient({
      url: hubEdge.url,
      accessClientId: HUB_CLIENT_ID,
      accessClientSecret: HUB_CLIENT_SECRET,
    }),
  );
  const logs: Array<Record<string, unknown>> = [];
  const mcp = createMcpEndpoint(service, (e) => logs.push({ level: "error", error: String(e) }));
  const app = createApp({
    service,
    verify: createAccessVerifier({ teamDomain: TEAM, audience: AUD, allowedEmails: [OWNER], allowedServiceTokens: [SERVICE_TOKEN], jwksUrl }),
    mcp,
    mcpAllowedOrigins: ["https://claude.ai"],
    log: (l) => logs.push(l),
    // Generous by default on purpose: these tests exercise Send itself, and the real budget is small
    // enough to throttle a file that sends a dozen times in milliseconds. The budget has its own
    // tests, and a test that wants the throttle injects its own small one.
    sendBudget: options.sendBudget ?? new SendBudget({ capacity: 10_000, refillPerSecond: 10_000 }),
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((r) => server.once("listening", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function token(claims: Record<string, unknown> = { email: OWNER }): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
  }

  return {
    base,
    app,
    token,
    logs,
    hub: hubEdge,
    async fetch(p, init = {}) {
      const { as, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (as !== null) headers.set("cf-access-jwt-assertion", await token(as ?? { email: OWNER }));
      return fetch(base + p, { ...rest, headers });
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await mcp.close();
      store.close();
      await hubEdge.close();
      await new Promise<void>((r) => jwksServer.close(() => r()));
    },
  };
}
