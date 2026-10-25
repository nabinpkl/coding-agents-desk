/* Bundles the extension into extension/dist and stamps the build identity
 * (version, git sha, time) into the panel title tooltip and the manifest
 * description shown on chrome://extensions. Run: just build-extension
 *
 * The server and sign-in origins, and the key that fixes the extension's id,
 * are not in the source: they come from the environment (see setting() below)
 * and are written into the built manifest and bundle.
 *
 * --watch: rebuild on every source change and serve the latest build id on
 * http://127.0.0.1:$HOT_RELOAD_PORT/events (default 50523). Watch builds inject
 * src/dev/hot-reload-*.ts, which reload the extension when the id changes.
 * Release builds contain none of it; rerun without --watch before shipping. */
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { build, type BuildOptions } from "esbuild";

const here = path.dirname(new URL(import.meta.url).pathname);
const src = path.join(here, "src");
const dist = path.join(here, "dist");
const staging = path.join(here, "dist-next");

function gitSha(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: here, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: here, encoding: "utf8" }).trim();
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return "nogit";
  }
}

/* Build config, from the environment: `just` loads agentdesk-annotator/.env (see .env.example).
 * Nothing here has a default, because an extension built against the wrong server signs in to
 * nothing and says so only at sign-in. */
function setting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set: put it in agentdesk-annotator/.env (see .env.example)`);
  return value;
}

/** The annotator server: an https origin, nothing after the host. */
function serverOrigin(): string {
  const value = setting("ANNOTATOR_URL").replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`ANNOTATOR_URL is not a URL: ${value}`);
  }
  if (url.protocol !== "https:" || url.origin !== value) {
    throw new Error(`ANNOTATOR_URL must be an https origin such as https://annotator.example.com, not ${value}`);
  }
  return url.origin;
}

/** The Access team serving sign-in, from the same domain deploy/.env names. */
function authOrigin(): string {
  const domain = setting("CF_ACCESS_TEAM_DOMAIN");
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(domain)) {
    throw new Error(`CF_ACCESS_TEAM_DOMAIN must be a domain such as <team>.cloudflareaccess.com, not ${domain}`);
  }
  return `https://${domain.toLowerCase()}`;
}

/**
 * The manifest `key`, which fixes the extension's id, from the PEM private key that
 * ANNOTATOR_EXTENSION_KEY_FILE names. The id matters because Access accepts the extension's
 * sign-in only at the redirect `https://<id>.chromiumapp.org/` allowed for it. Without a key,
 * Chrome derives the id from the folder the extension is loaded from.
 */
function extensionKey(): { key: string; id: string } | null {
  const file = process.env.ANNOTATOR_EXTENSION_KEY_FILE?.trim();
  if (!file) return null;
  const pem = fs.readFileSync(file.replace(/^~(?=\/)/, os.homedir()), "utf8");
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  // Chrome's id: the first 128 bits of the key's SHA-256, each hex digit written as a letter a to p.
  const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
  const id = [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
  return { key: der.toString("base64"), id };
}

const SERVER_ORIGIN = serverOrigin();
const AUTH_ORIGIN = authOrigin();
const pinned = extensionKey();

const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8")) as { version: string; description: string };
const watch = process.argv.includes("--watch");
const reloadPort = Number(process.env.HOT_RELOAD_PORT ?? 50523);
const reloadUrl = `http://127.0.0.1:${reloadPort}/events`;

async function buildOnce(buildId: string | null): Promise<string> {
  const stamp = {
    version: manifest.version,
    sha: buildId ? `${gitSha()} dev` : gitSha(),
    at: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
  };
  // Build into a staging directory and swap it in, so a failed build leaves the last good dist in place.
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const common: BuildOptions = {
    bundle: true,
    target: "chrome120",
    sourcemap: "linked",
    logLevel: "warning",
    define: {
      __BUILD__: JSON.stringify(stamp),
      __SERVER_ORIGIN__: JSON.stringify(SERVER_ORIGIN),
      __AUTH_ORIGIN__: JSON.stringify(AUTH_ORIGIN),
      ...(buildId ? { __DEV_BUILD_ID__: JSON.stringify(buildId), __DEV_RELOAD_URL__: JSON.stringify(reloadUrl) } : {}),
    },
  };
  const dev = (file: string): Pick<BuildOptions, "inject"> => (buildId ? { inject: [path.join(src, "dev", file)] } : {});

  await Promise.all([
    // The service worker is declared "type": "module" in the manifest.
    build({ ...common, ...dev("hot-reload-worker.ts"), entryPoints: [path.join(src, "background.ts")], outfile: path.join(staging, "background.js"), format: "esm" }),
    // Content scripts are classic scripts.
    build({ ...common, ...dev("hot-reload-content.ts"), entryPoints: [path.join(src, "content/index.ts")], outfile: path.join(staging, "content.js"), format: "iife" }),
  ]);

  fs.copyFileSync(path.join(here, "content.css"), path.join(staging, "content.css"));
  // The extension fetches both origins, and its Origin-stripping DNR rule needs host access to AUTH_ORIGIN.
  const built = {
    ...manifest,
    ...(pinned ? { key: pinned.key } : {}),
    description: `${manifest.description} (build ${stamp.sha})`,
    host_permissions: [`${SERVER_ORIGIN}/*`, `${AUTH_ORIGIN}/*`],
  };
  fs.writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(built, null, 2)}\n`);
  fs.rmSync(dist, { recursive: true, force: true });
  fs.renameSync(staging, dist);
  const id = pinned ? `id ${pinned.id}` : "id chosen by Chrome from the folder it is loaded from";
  return `v${stamp.version} ${stamp.sha} ${stamp.at} for ${SERVER_ORIGIN}, ${id}`;
}

if (!watch) {
  console.log(`extension/dist built: ${await buildOnce(null)}`);
} else {
  let current = String(Date.now());
  console.log(`extension/dist built: ${await buildOnce(current)}`);

  const clients = new Set<http.ServerResponse>();
  const announce = (res: http.ServerResponse) => res.write(`data: ${current}\n\n`);
  http
    .createServer((req, res) => {
      if (req.url !== "/events") {
        res.writeHead(404).end();
        return;
      }
      const origin = req.headers.origin ?? "";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        // Only extension pages and workers may read the stream.
        ...(origin.startsWith("chrome-extension://") ? { "access-control-allow-origin": origin } : {}),
      });
      announce(res);
      clients.add(res);
      req.on("close", () => clients.delete(res));
    })
    .listen(reloadPort, "127.0.0.1", () => console.log(`hot reload: ${reloadUrl}`));

  // The manifest is read once at startup, so a manifest edit needs a restart of the watcher.
  const watched = [src, path.join(here, "..", "shared"), path.join(here, "content.css")];
  let timer: NodeJS.Timeout | undefined;
  let building = Promise.resolve();
  for (const target of watched) {
    fs.watch(target, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        building = building.then(async () => {
          const next = String(Date.now());
          try {
            const label = await buildOnce(next);
            current = next;
            for (const res of clients) announce(res);
            console.log(`rebuilt ${label}, reloading ${clients.size} extension(s)`);
          } catch (e) {
            // esbuild already printed the error; keep serving the last good build.
            console.error(`build failed, extension left on the previous build: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
          }
        });
      }, 100);
    });
  }
}
