// Every request except /health carries a Cloudflare Access JWT. Service tokens named in
// HUB_PRINCIPALS are accepted, and what each may do comes from that table, never from the request.
// The owner is the second way in: a Managed OAuth user token whose email matches HUB_OWNER_EMAIL
// identifies as themselves rather than as a machine, and may speak as a session on any machine
// plus as human. One owner owns all machines, so scoping an owner login to one of them would be
// theatre; the email allowlist of exactly one is the whole boundary.

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { HubConfig, Principal } from "@/config";

export class Unauthorized extends Error {}

/**
 * A verified caller: what it may do, and which service token it proved itself with.
 *
 * The client id travels with the principal because it is the only part of the identity Cloudflare
 * vouched for. A budget keyed on anything the caller chooses for itself is a budget it can reset.
 */
export interface Identified {
  principal: Principal;
  clientId: string;
}

export type Verifier = (assertion: string | null) => Promise<Identified>;

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
    if (principal) return { principal, clientId };
    const email = typeof payload.email === "string" ? payload.email : "";
    if (config.ownerEmail && email === config.ownerEmail) {
      return { principal: { label: "owner", machine: null, human: true, owner: true }, clientId: email };
    }
    if (clientId) throw new Unauthorized(`service token ${clientId} is not a hub principal`);
    // Temporary diagnostic while the opencode OAuth login is being brought up: claim names, never
    // values, so a rejection says what identity the edge actually asserted.
    throw new Unauthorized(`only service tokens and the owner may use the hub (claims: ${Object.keys(payload).sort().join(",")})`);
  };
}
