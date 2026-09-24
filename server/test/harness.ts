/* Boots the real HTTP app on an ephemeral port with a temp database and a
 * local JWKS, and mints Access-style JWTs for tests. */
import { serve } from "@hono/node-server";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAccessVerifier } from "../src/auth/access-jwt.ts";
import { createApp } from "../src/http/app.ts";
import { createMcpEndpoint } from "../src/mcp/mcp-endpoint.ts";
import { createAnnotationService } from "../src/service/annotations.ts";
import { openSqliteStore } from "../src/store/sqlite-store.ts";

export const OWNER = "owner@example.com";
export const SERVICE_TOKEN = "svc-e2e.access";
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-test";

export interface Harness {
  base: string;
  /** The Hono app itself, for in-process requests that must not touch a socket. */
  app: ReturnType<typeof createApp>;
  token(claims?: Record<string, unknown>): Promise<string>;
  fetch(p: string, init?: RequestInit & { as?: Record<string, unknown> | null }): Promise<Response>;
  logs: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
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
  const service = createAnnotationService(store);
  const logs: Array<Record<string, unknown>> = [];
  const mcp = createMcpEndpoint(service, (e) => logs.push({ level: "error", error: String(e) }));
  const app = createApp({
    service,
    verify: createAccessVerifier({ teamDomain: TEAM, audience: AUD, allowedEmails: [OWNER], allowedServiceTokens: [SERVICE_TOKEN], jwksUrl }),
    mcp,
    mcpAllowedOrigins: ["https://claude.ai"],
    log: (l) => logs.push(l),
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
      await new Promise<void>((r) => jwksServer.close(() => r()));
    },
  };
}
