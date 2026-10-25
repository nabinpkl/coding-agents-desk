/* Verifies the Cf-Access-Jwt-Assertion header Cloudflare Access adds to
 * every request it lets through. The signature, issuer, audience and expiry
 * must hold, and the identity must be on the allowlist: a human by email
 * (OAuth or browser login) or a service token by its client id
 * (common_name). Network location is never trusted. */
import { createRemoteJWKSet, errors, jwtVerify } from "jose";

export type Identity = { kind: "user"; email: string } | { kind: "service"; clientId: string };

export class Unauthorized extends Error {
  constructor(reason: string) {
    super(`unauthorized: ${reason}`);
    this.name = "Unauthorized";
  }
}

export interface AccessVerifierOptions {
  /** e.g. <team>.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  allowedEmails: string[];
  allowedServiceTokens: string[];
  /** Override for tests; defaults to https://<teamDomain>/cdn-cgi/access/certs. */
  jwksUrl?: URL;
  /** Minimum wait before refetching the JWKS on an unknown kid. jose's default applies when unset. */
  jwksCooldownMs?: number;
}

export type AccessVerifier = (assertion: string | undefined) => Promise<Identity>;

export function createAccessVerifier(opts: AccessVerifierOptions): AccessVerifier {
  const issuer = `https://${opts.teamDomain}`;
  const jwks = createRemoteJWKSet(opts.jwksUrl ?? new URL(`${issuer}/cdn-cgi/access/certs`), {
    ...(opts.jwksCooldownMs === undefined ? {} : { cooldownDuration: opts.jwksCooldownMs }),
  });
  const emails = new Set(opts.allowedEmails.map((e) => e.toLowerCase()));
  const services = new Set(opts.allowedServiceTokens);

  return async (assertion) => {
    if (!assertion) throw new Unauthorized("missing Cf-Access-Jwt-Assertion");
    let payload;
    try {
      ({ payload } = await jwtVerify(assertion, jwks, { issuer, audience: opts.audience, algorithms: ["RS256"] }));
    } catch (e) {
      if (e instanceof errors.JOSEError) throw new Unauthorized(e.code);
      throw e;
    }
    const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
    if (email && emails.has(email)) return { kind: "user", email };
    const clientId = typeof payload.common_name === "string" ? payload.common_name : "";
    if (clientId && services.has(clientId)) return { kind: "service", clientId };
    throw new Unauthorized(`identity not allowed (${email || clientId || "none"})`);
  };
}
