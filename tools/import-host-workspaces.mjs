// One-time import of the Mac host's workspace registry into the sidecar's roster.
//
// The IDE moved off the compile path (ADR-0115) and its roster moved with it, from the host's
// `workspaces.json` to the sidecar's. The move never carried the existing entries across, so a
// reader who had fifteen projects registered opened the new IDE and found whichever one they had
// added since.
//
// A tool rather than code in the sidecar, deliberately. Migration scaffolding inside the product
// has to be read, maintained and eventually deleted by everyone who comes after it, for a job that
// happens once per machine; this runs once and leaves nothing behind. The sidecar still decodes
// only its own shape and has no idea this file exists.
//
// Idempotent by root: an entry already in the roster is left exactly as it is, so running this
// twice does not duplicate anything and does not overwrite a name the reader has since changed.

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const bundleId = process.env.AGENTDESK_HOST_BUNDLE_ID ?? "com.example.agentdesk.AgentDeskHost";
const sidecar = process.env.AGENT_FEED_ORIGIN ?? "http://127.0.0.1:7682";
const registry = process.env.AGENTDESK_HOST_WORKSPACES
  ?? join(homedir(), "Library", "Application Support", bundleId, "workspaces.json");

if (!existsSync(registry)) {
  console.error(`no host registry at ${registry}`);
  process.exit(1);
}

/** The host stores roots as file URLs with a trailing slash; the sidecar wants a plain path. */
function rootPath(value) {
  return decodeURIComponent(new URL(value).pathname).replace(/\/$/, "");
}

const host = JSON.parse(await readFile(registry, "utf8"));
const existing = await fetch(`${sidecar}/api/workspace/list`).then((response) => {
  if (!response.ok) throw new Error(`sidecar answered ${response.status} to /api/workspace/list`);
  return response.json();
});
const known = new Set(existing.workspaces.map((workspace) => workspace.root));

let added = 0;
let skipped = 0;
for (const workspace of host.workspaces ?? []) {
  const root = rootPath(workspace.root);
  if (known.has(root)) {
    console.log(`have    ${workspace.name}  ${root}`);
    skipped += 1;
    continue;
  }
  if (!existsSync(root)) {
    // Reported rather than passed on: the sidecar would refuse it anyway, and the reader wants to
    // know which project moved, not that one request failed.
    console.log(`gone    ${workspace.name}  ${root}`);
    skipped += 1;
    continue;
  }
  const response = await fetch(`${sidecar}/api/workspace/add`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root, name: workspace.name }),
  });
  if (!response.ok) {
    console.log(`refused ${workspace.name}  ${root}  (${response.status} ${await response.text()})`);
    skipped += 1;
    continue;
  }
  console.log(`added   ${workspace.name}  ${root}`);
  added += 1;
}

console.log(`\n${added} added, ${skipped} left alone`);
