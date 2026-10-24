// Where the commit-timeline site reads and writes. One home for every path and port the generator
// and the server share, so `just commits-timeline` and a direct `node serve.mjs` cannot disagree.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = join(here, "..", "..");
export const PUBLIC_DIR = join(here, "public");

// Generated into the ignored `.build/` tree, never committed: the data carries commit authors and
// messages, which are this machine's history and not something the public tree should hold a copy
// of. The site itself is the committed part.
export const BUILD_DIR = join(REPO_ROOT, ".build", "commits-timeline");
export const DATA_FILE = join(BUILD_DIR, "data.json");
export const PID_FILE = join(BUILD_DIR, "serve.pid");

export const HOST = "127.0.0.1";
export const PORT = Number(process.env.AGENTDESK_COMMITS_PORT ?? 4290);

// The tailnet origin is derived from the machine's own tailscale state at run time. It is never
// written down in the tree: a tailnet name is personal, and gate check 10 fails on one.
export function tailnetOrigin(port = PORT) {
  try {
    const status = JSON.parse(execFileSync("tailscale", ["status", "--json"], { encoding: "utf8" }));
    const dnsName = status?.Self?.DNSName?.replace(/\.$/, "");
    if (status?.BackendState !== "Running" || !dnsName) return null;
    return `https://${dnsName}:${port}`;
  } catch {
    return null;
  }
}
