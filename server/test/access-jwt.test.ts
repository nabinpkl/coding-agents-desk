import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { createAccessVerifier, Unauthorized } from "../src/auth/access-jwt.ts";

const TEAM = "team.cloudflareaccess.com";
const ISS = `https://${TEAM}`;
const AUD = "aud-tag-123";

let server: http.Server;
let jwksUrl: URL;
const published: JWK[] = [];
let keyA: { privateKey: CryptoKey; kid: string };
let keyB: { privateKey: CryptoKey; kid: string };

async function makeKey(kid: string) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { privateKey, kid, jwk };
}

before(async () => {
  const a = await makeKey("kid-a");
  const b = await makeKey("kid-b");
  keyA = a;
  keyB = b;
  published.push(a.jwk);
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: published }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  jwksUrl = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/cdn-cgi/access/certs`);
});

after(() => server.close());

function verifier() {
  return createAccessVerifier({
    teamDomain: TEAM,
    audience: AUD,
    allowedEmails: ["owner@example.com"],
    allowedServiceTokens: ["svc-123.access"],
    jwksUrl,
    jwksCooldownMs: 0,
  });
}

async function sign(claims: Record<string, unknown>, opts: { key?: { privateKey: CryptoKey; kid: string }; iss?: string; aud?: string | string[]; exp?: number } = {}) {
  const key = opts.key ?? keyA;
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 600)
    .sign(key.privateKey);
}

test("accepts an allowed email (case-insensitive) and an array audience", async () => {
  const id = await verifier()(await sign({ email: "Owner@Example.com", sub: "u1" }, { aud: ["other", AUD] }));
  assert.deepEqual(id, { kind: "user", email: "owner@example.com" });
});

test("accepts an allowed service token by common_name", async () => {
  const id = await verifier()(await sign({ common_name: "svc-123.access", sub: "" }));
  assert.deepEqual(id, { kind: "service", clientId: "svc-123.access" });
});

test("rejects missing, malformed, expired, wrong audience, wrong issuer", async () => {
  const v = verifier();
  await assert.rejects(v(undefined), Unauthorized);
  await assert.rejects(v(""), Unauthorized);
  await assert.rejects(v("not-a-jwt"), Unauthorized);
  await assert.rejects(v(await sign({ email: "owner@example.com" }, { exp: Math.floor(Date.now() / 1000) - 3600 })), Unauthorized);
  await assert.rejects(v(await sign({ email: "owner@example.com" }, { aud: "someone-else" })), Unauthorized);
  await assert.rejects(v(await sign({ email: "owner@example.com" }, { iss: "https://evil.cloudflareaccess.com" })), Unauthorized);
});

test("rejects identities not on the allowlist", async () => {
  const v = verifier();
  await assert.rejects(v(await sign({ email: "stranger@example.com" })), /not allowed/);
  await assert.rejects(v(await sign({ common_name: "other.access" })), /not allowed/);
  await assert.rejects(v(await sign({ sub: "no-identity" })), /not allowed/);
});

test("rejects a token signed by a key that is not published", async () => {
  await assert.rejects(verifier()(await sign({ email: "owner@example.com" }, { key: keyB })), Unauthorized);
});

test("picks up a rotated key by refetching the JWKS on an unknown kid", async () => {
  const v = verifier();
  assert.equal((await v(await sign({ email: "owner@example.com" }))).kind, "user");
  const rotated = await makeKey("kid-c");
  published.push(rotated.jwk);
  assert.equal((await v(await sign({ email: "owner@example.com" }, { key: rotated }))).kind, "user");
});
