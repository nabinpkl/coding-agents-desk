// Rotate the hub's Access service tokens and install each new secret, without any secret leaving
// this process except into the file that is supposed to hold it.
//
// Run from the agent-desk repo root. Reads the API token from agent-feed/hub/deploy/.env, and never
// prints a client secret: it prints a digest prefix, which is enough to prove a value changed and
// not enough to reconstruct one.
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const ACCOUNT = "00000000000000000000000000000000";
const TOKEN_FILE = "agent-feed/hub/deploy/.env";
const HOME = homedir();

const apiToken = readFileSync(TOKEN_FILE, "utf8")
  .split("\n")
  .find((l) => l.startsWith("CLOUDFLARE_ACCESS_TOKEN="))
  ?.split("=")[1]
  .trim();
if (!apiToken) throw new Error(`${TOKEN_FILE} has no CLOUDFLARE_ACCESS_TOKEN`);

const digest = (v) => createHash("sha256").update(v).digest("hex").slice(0, 12);

function upsert(path, key, value) {
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const line = `${key}=${value}`;
  const next = new RegExp(`^${key}=.*$`, "m").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "m"), line)
    : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  writeFileSync(path, next);
  chmodSync(path, 0o600);
}

/**
 * Installs a secret on oracle, without displaying it and without a multi-line remote command.
 *
 * ssh joins its arguments with spaces, so the rewrite is base64'd and decoded on the far side, and
 * the secret itself arrives on stdin. Nothing secret is ever an argument, so it cannot turn up in a
 * process listing on either machine.
 */
function upsertOnOracle(path, key, secret) {
  const script = `
import sys, pathlib, re, os
secret = sys.stdin.read().strip()
assert secret.startswith("cfast_") and len(secret) == 54, "implausible secret on the wire"
p = pathlib.Path(${JSON.stringify(path)})
t = p.read_text()
new, n = re.subn(r"^${key}=.*$", "${key}=" + secret, t, flags=re.M)
assert n == 1, "expected exactly one ${key} line in " + str(p)
p.write_text(new); os.chmod(p, 0o600)
print("ok")
`;
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const remote = `python3 -c "import base64,sys;exec(base64.b64decode(sys.argv[1]))" ${encoded}`;
  const out = execFileSync("ssh", ["oracle", remote], { input: secret + "\n", encoding: "utf8" });
  if (!out.includes("ok")) throw new Error(`oracle write failed for ${key}: ${out.slice(0, 120)}`);
}

const targets = [
  { name: "hub-mac", id: "00000000-0000-4000-8000-000000000011", key: "CF_ACCESS_CLIENT_SECRET", where: `${HOME}/.config/agentdesk-relay/hub.env` },
  { name: "hub-panel", id: "00000000-0000-4000-8000-000000000012", key: "CF_ACCESS_CLIENT_SECRET", where: `${HOME}/.config/agentdesk-relay/panel.env` },
  { name: "annotator-e2e", id: "00000000-0000-4000-8000-000000000013", key: "E2E_CF_ACCESS_CLIENT_SECRET", where: `${HOME}/.config/agentdesk-annotator/e2e.env` },
  { name: "hub-oracle", id: "00000000-0000-4000-8000-000000000014", key: "CF_ACCESS_CLIENT_SECRET", where: "/home/ubuntu/.config/agentdesk-relay/hub.env", remote: true },
  { name: "hub-annotator", id: "00000000-0000-4000-8000-000000000015", key: "HUB_ACCESS_CLIENT_SECRET", where: "/home/ubuntu/.local/share/agentdesk/repo/agentdesk-annotator/deploy/.env", remote: true },
];

for (const t of targets) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/access/service_tokens/${t.id}/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
  });
  const body = await res.json();
  const secret = body?.result?.client_secret;
  if (!res.ok || typeof secret !== "string") throw new Error(`${t.name}: rotate failed ${res.status} ${JSON.stringify(body?.errors).slice(0, 160)}`);
  if (!secret.startsWith("cfast_") || secret.length !== 54) throw new Error(`${t.name}: implausible secret shape`);
  if (t.remote) upsertOnOracle(t.where, t.key, secret);
  else upsert(t.where, t.key, secret);
  console.log(`  ${t.name.padEnd(15)} rotated -> ${digest(secret)}  installed in ${t.remote ? "oracle:" : ""}${t.where.replace(HOME, "~")}`);
}
chmodSync(TOKEN_FILE, 0o600);
console.log(`  token file tightened to 600: ${TOKEN_FILE}`);
