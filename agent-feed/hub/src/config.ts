// The hub's environment, read once at boot. A missing required value throws before anything listens.

import { join } from "node:path";

/** What one Access service token may do, keyed by the token's client id. */
export interface Principal {
  /** Which machine's sessions this token may speak for, or null for a token that speaks for none. */
  machine: string | null;
  /** Whether this token may send as `human`: the human surfaces (agent-desk panel, annotator). */
  human: boolean;
  /** Short label for logs. */
  label: string;
  /**
   * Whether this is the owner logging in as themselves (Managed OAuth, owner email only) rather
   * than a machine service token. An owner login carries no machine, so it may speak as a session
   * on any machine: the owner owns all of them. Recorded deliberately; see docs/agent-messaging.md.
   */
  owner: boolean;
}

export interface HubConfig {
  host: string;
  port: number;
  dbFile: string;
  access: {
    teamDomain: string;
    audience: string;
    /** Only tests and the local stand-in edge set this; production uses the team's own certs. */
    jwksUrl: string;
  };
  principals: Map<string, Principal>;
  /**
   * The owner email allowed in as themselves through Managed OAuth. Null disables owner login:
   * the hub then speaks only to service tokens. Set from HUB_OWNER_EMAIL, which is optional
   * precisely so an existing deploy boots unchanged until its .env grows the line.
   */
  ownerEmail: string | null;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/**
 * `HUB_PRINCIPALS` is `clientId=label:machine[:human]` entries separated by commas, for example
 * `abc.access=mac:mac:human,def.access=annotator::human`. An empty machine means the token speaks
 * for no sessions.
 */
export function parsePrincipals(text: string): Map<string, Principal> {
  const principals = new Map<string, Principal>();
  for (const entry of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [clientId, spec] = entry.split("=");
    if (!clientId || !spec) throw new Error(`HUB_PRINCIPALS entry is not clientId=label:machine[:human]: ${entry}`);
    const [label, machine, flag] = spec.split(":");
    if (!label) throw new Error(`HUB_PRINCIPALS entry has no label: ${entry}`);
    if (flag !== undefined && flag !== "human" && flag !== "") throw new Error(`HUB_PRINCIPALS flag must be "human": ${entry}`);
    principals.set(clientId, { label, machine: machine ? machine : null, human: flag === "human", owner: false });
  }
  if (principals.size === 0) throw new Error("HUB_PRINCIPALS names no tokens");
  return principals;
}

export function loadConfig(env: NodeJS.ProcessEnv): HubConfig {
  const port = Number(required(env, "HUB_PORT"));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`HUB_PORT is not a valid port: ${env.HUB_PORT}`);
  const teamDomain = required(env, "CF_ACCESS_TEAM_DOMAIN").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return {
    host: env.HUB_HOST?.trim() || "127.0.0.1",
    port,
    dbFile: join(required(env, "HUB_DATA_DIR"), "hub.db"),
    access: {
      teamDomain,
      audience: required(env, "CF_ACCESS_AUD"),
      jwksUrl: env.HUB_JWKS_URL?.trim() || `https://${teamDomain}/cdn-cgi/access/certs`,
    },
    principals: parsePrincipals(required(env, "HUB_PRINCIPALS")),
    ownerEmail: env.HUB_OWNER_EMAIL?.trim() || null,
  };
}
