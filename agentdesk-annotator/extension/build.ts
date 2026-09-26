/* Bundles the extension into extension/dist and stamps the build identity
 * (version, git sha, time) into the panel title tooltip and the manifest
 * description shown on chrome://extensions. Run: node extension/build.ts
 *
 * --watch: rebuild on every source change and serve the latest build id on
 * http://127.0.0.1:$HOT_RELOAD_PORT/events (default 50523). Watch builds inject
 * src/dev/hot-reload-*.ts, which reload the extension when the id changes.
 * Release builds contain none of it; rerun without --watch before shipping. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { build, type BuildOptions } from "esbuild";
import { AUTH_ORIGIN, SERVER_ORIGIN } from "./src/origins.ts";

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

const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8")) as { version: string; description: string; host_permissions: string[] };
// The extension fetches both origins, and its Origin-stripping DNR rule needs host access to AUTH_ORIGIN.
for (const origin of [SERVER_ORIGIN, AUTH_ORIGIN]) {
  if (!manifest.host_permissions.includes(`${origin}/*`)) throw new Error(`manifest.json host_permissions must include ${origin}/*`);
}
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
  fs.writeFileSync(
    path.join(staging, "manifest.json"),
    `${JSON.stringify({ ...manifest, description: `${manifest.description} (build ${stamp.sha})` }, null, 2)}\n`,
  );
  fs.rmSync(dist, { recursive: true, force: true });
  fs.renameSync(staging, dist);
  return `v${stamp.version} ${stamp.sha} ${stamp.at}`;
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
