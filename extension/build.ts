/* Bundles the extension into extension/dist and stamps the build identity
 * (version, git sha, time) into the popup footer and the manifest
 * description shown on chrome://extensions. Run: node extension/build.ts */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build, type BuildOptions } from "esbuild";
import { AUTH_ORIGIN, SERVER_ORIGIN } from "./src/origins.ts";

const here = path.dirname(new URL(import.meta.url).pathname);
const src = path.join(here, "src");
const dist = path.join(here, "dist");

function gitSha(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: here, encoding: "utf8" }).trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return "nogit";
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8")) as { version: string; description: string; host_permissions: string[] };
// The extension fetches both origins, and its Origin-stripping DNR rule needs host access to AUTH_ORIGIN.
for (const origin of [SERVER_ORIGIN, AUTH_ORIGIN]) {
  if (!manifest.host_permissions.includes(`${origin}/*`)) throw new Error(`manifest.json host_permissions must include ${origin}/*`);
}
const stamp = { version: manifest.version, sha: gitSha(), at: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC" };

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

const common: BuildOptions = {
  bundle: true,
  target: "chrome120",
  sourcemap: "linked",
  logLevel: "warning",
  define: { __BUILD__: JSON.stringify(stamp) },
};

await Promise.all([
  // The service worker is declared "type": "module" in the manifest.
  build({ ...common, entryPoints: [path.join(src, "background.ts")], outfile: path.join(dist, "background.js"), format: "esm" }),
  // Content scripts and the popup are classic scripts.
  build({ ...common, entryPoints: [path.join(src, "content/index.ts")], outfile: path.join(dist, "content.js"), format: "iife" }),
  build({ ...common, entryPoints: [path.join(src, "popup.ts")], outfile: path.join(dist, "popup.js"), format: "iife" }),
]);

fs.copyFileSync(path.join(src, "popup.html"), path.join(dist, "popup.html"));
fs.copyFileSync(path.join(src, "popup.css"), path.join(dist, "popup.css"));
fs.copyFileSync(path.join(here, "content.css"), path.join(dist, "content.css"));
fs.writeFileSync(
  path.join(dist, "manifest.json"),
  `${JSON.stringify({ ...manifest, description: `${manifest.description} (build ${stamp.sha})` }, null, 2)}\n`,
);

console.log(`extension/dist built: v${stamp.version} ${stamp.sha} ${stamp.at}`);
