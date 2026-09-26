/* Environment configuration. Every required value must be present at boot;
 * there is deliberately no unauthenticated or "dev" mode. */
import path from "node:path";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  access: {
    teamDomain: string;
    audience: string;
    allowedEmails: string[];
    allowedServiceTokens: string[];
  };
  /** Origins allowed to send an Origin header to /mcp. Requests without Origin are allowed. */
  mcpAllowedOrigins: string[];
  /** The agent hub, for Send. The Access service token is sent as headers, so nothing else. */
  hub: {
    url: string;
    accessClientId: string;
    accessClientSecret: string;
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

/** A base URL with no trailing slash, so callers can append `/v1/...` without doubling it. */
function baseUrl(env: NodeJS.ProcessEnv, name: string): string {
  return required(env, name).replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const port = Number(required(env, "ANNOTATOR_PORT"));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`ANNOTATOR_PORT is not a valid port: ${env.ANNOTATOR_PORT}`);
  const dataDir = required(env, "ANNOTATOR_DATA_DIR");
  const allowedEmails = list(required(env, "ANNOTATOR_ALLOWED_EMAILS")).map((e) => e.toLowerCase());
  const allowedServiceTokens = list(env.ANNOTATOR_ALLOWED_SERVICE_TOKENS);
  const teamDomain = required(env, "CF_ACCESS_TEAM_DOMAIN").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return {
    host: env.ANNOTATOR_HOST?.trim() || "127.0.0.1",
    port,
    dataDir,
    dbFile: path.join(dataDir, "annotator.db"),
    access: {
      teamDomain,
      audience: required(env, "CF_ACCESS_AUD"),
      allowedEmails,
      allowedServiceTokens,
    },
    mcpAllowedOrigins: ["https://claude.ai", ...list(env.ANNOTATOR_MCP_ALLOWED_ORIGINS)],
    hub: {
      url: baseUrl(env, "HUB_URL"),
      accessClientId: required(env, "HUB_ACCESS_CLIENT_ID"),
      accessClientSecret: required(env, "HUB_ACCESS_CLIENT_SECRET"),
    },
  };
}
