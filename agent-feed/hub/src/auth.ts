// Every request except /health carries a Cloudflare Access JWT. Only service tokens named in
// HUB_PRINCIPALS are accepted, and what each may do comes from that table, never from the request.

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { HubConfig, Principal } from "@/config";

export class Unauthorized extends Error {}

export type Verifier = (assertion: string | null) => Promise<Principal>;

export function createVerifier(config: HubConfig): Verifier {
  const jwks = createRemoteJWKSet(new URL(config.access.jwksUrl));
  return async (assertion) => {
    if (!assertion) throw new Unauthorized("missing Cf-Access-Jwt-Assertion");
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(assertion, jwks, {
        issuer: `https://${config.access.teamDomain}`,
        audience: config.access.audience,
      }));
    } catch (error) {
      throw new Unauthorized(`invalid Access token: ${error instanceof Error ? error.message : String(error)}`);
    }
    const clientId = typeof payload.common_name === "string" ? payload.common_name : "";
    const principal = config.principals.get(clientId);
    if (!principal) throw new Unauthorized(clientId ? `service token ${clientId} is not a hub principal` : "only service tokens may use the hub");
    return principal;
  };
}
