// Rotate the hub's Access service tokens and install each new secret, without any secret leaving
// this process except into the file that is supposed to hold it.
//
// Run from the agent-desk repo root. Reads the API token from agent-feed/hub/deploy/.env, and the
// account and token table from agent-feed/hub/deploy/service-tokens.json (gitignored: its ids are
// one deployment's; service-tokens.example.json shows the shape). Never prints a client secret: it
// prints a digest prefix, which is enough to prove a value changed and not enough to reconstruct one.
//
//   node agent-feed/hub/deploy/rotate-service-tokens.mjs           rotate every token in the table
//   node agent-feed/hub/deploy/rotate-service-tokens.mjs --check   validate and list, call nothing
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";

const TOKEN_FILE = "agent-feed/hub/deploy/.env";
const TABLE_FILE = "agent-feed/hub/deploy/service-tokens.json";
const HOME = homedir();

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("usage: rotate-service-tokens.mjs [--check]");
}
const checkOnly = args[0] === "--check";

const apiToken = readFileSync(TOKEN_FILE, "utf8")
  .split("\n")
  .find((l) => l.startsWith("CLOUDFLARE_ACCESS_TOKEN="))
  ?.split("=")[1]
  .trim();
if (!apiToken) throw new Error(`${TOKEN_FILE} has no CLOUDFLARE_ACCESS_TOKEN`);

/**
 * The table, checked whole before anything is rotated: a bad entry found halfway would leave some
 * tokens rotated and the rest still holding secrets that no longer work.
 *
 * Each token names the env key its secret goes under and the file holding it. A token with a `host`
 * is installed over ssh on that host (an ssh alias), and its file must be absolute there; a local
 * file may start with `~/`.
 */
function loadTable(path) {
  if (!existsSync(path)) throw new Error(`${path} is missing; copy service-tokens.example.json beside it and fill it in`);
  const table = JSON.parse(readFileSync(path, "utf8"));
  if (!/^[0-9a-f]{32}$/.test(table?.account ?? "")) throw new Error(`${path}: account must be a 32-character Cloudflare account id`);
  if (!Array.isArray(table.tokens) || table.tokens.length === 0) throw new Error(`${path}: tokens must be a non-empty list`);
  const names = new Set();
  const tokens = table.tokens.map((t, index) => {
    const where = `${path}: tokens[${index}]`;
    if (typeof t?.name !== "string" || t.name === "" || names.has(t.name)) throw new Error(`${where}: name must be present and unique`);
    names.add(t.name);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t.id ?? "")) throw new Error(`${where}: id must be a service token uuid`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(t.key ?? "")) throw new Error(`${where}: key must be an env variable name`);
    // The host is one argument to ssh, so it must not read as an option.
    if (t.host !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(t.host)) throw new Error(`${where}: host must be an ssh alias`);
    if (typeof t.file !== "string") throw new Error(`${where}: file must be a path`);
    const file = t.host === undefined && t.file.startsWith("~/") ? join(HOME, t.file.slice(2)) : t.file;
    if (!isAbsolute(file)) throw new Error(`${where}: file must be absolute${t.host === undefined ? " or start with ~/" : " on its host"}`);
    return { name: t.name, id: t.id, key: t.key, host: t.host, file };
  });
  return { account: table.account, tokens };
}

const { account, tokens } = loadTable(TABLE_FILE);

const digest = (v) => createHash("sha256").update(v).digest("hex").slice(0, 12);
const shown = (t) => `${t.host ? `${t.host}:` : ""}${t.file.replace(HOME, "~")}`;

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
 * Installs a secret on another machine, without displaying it and without a multi-line remote
 * command.
 *
 * ssh joins its arguments with spaces, so the rewrite is base64'd and decoded on the far side, and
 * the secret itself arrives on stdin. Nothing secret is ever an argument, so it cannot turn up in a
 * process listing on either machine.
 */
function upsertOverSsh(host, path, key, secret) {
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
  const out = execFileSync("ssh", [host, remote], { input: secret + "\n", encoding: "utf8" });
  if (!out.includes("ok")) throw new Error(`${host} write failed for ${key}: ${out.slice(0, 120)}`);
}

if (checkOnly) {
  console.log(`  ${tokens.length} tokens in account ${account.slice(0, 6)}…, API token present`);
  for (const t of tokens) console.log(`  ${t.name.padEnd(15)} ${t.key} in ${shown(t)}`);
  process.exit(0);
}

for (const t of tokens) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/access/service_tokens/${t.id}/rotate`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
  });
  const body = await res.json();
  const secret = body?.result?.client_secret;
  if (!res.ok || typeof secret !== "string") throw new Error(`${t.name}: rotate failed ${res.status} ${JSON.stringify(body?.errors).slice(0, 160)}`);
  if (!secret.startsWith("cfast_") || secret.length !== 54) throw new Error(`${t.name}: implausible secret shape`);
  if (t.host) upsertOverSsh(t.host, t.file, t.key, secret);
  else upsert(t.file, t.key, secret);
  console.log(`  ${t.name.padEnd(15)} rotated -> ${digest(secret)}  installed in ${shown(t)}`);
}
chmodSync(TOKEN_FILE, 0o600);
console.log(`  token file tightened to 600: ${TOKEN_FILE}`);
