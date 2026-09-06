import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runtimePaths } from "../runtime-paths.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const origin = "https://fixture.invalid:5173";

// Execute the actual recipe with only its external operations replaced. No real
// listener, certificate, credential, dependency tree, or app is touched.
async function fixture(t, { serving = true, token = true, tls = true, failure = "" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agentdesk-panel-ensure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const env = {
    ...process.env,
    AGENTDESK_RUNTIME_ROOT: join(root, "runtime with spaces"),
    AGENTDESK_AGENT_PANEL_DEV_PORT: "5173",
    AGENTDESK_AGENT_PANEL_DEV_LOG: join(root, "vite.log"),
    // The fixture never brings a server up, so the failure path would otherwise spend the
    // recipe's full 20s readiness budget proving the obvious. Three attempts exercise the
    // same loop and the same error.
    AGENTDESK_AGENT_PANEL_DEV_READY_ATTEMPTS: "3",
    FIXTURE_ROOT: root,
    FIXTURE_FAILURE: failure,
  };
  const paths = runtimePaths(env);
  await mkdir(bin);
  await mkdir(paths.panelTlsDirectory, { recursive: true });
  if (serving) await writeFile(join(root, "serving"), "yes");
  if (tls) {
    await writeFile(join(paths.panelTlsDirectory, "fixture.invalid.crt"), "certificate");
    await writeFile(join(paths.panelTlsDirectory, "fixture.invalid.key"), "key");
  }
  const dryRun = spawnSync("just", ["--dry-run", "agent-webview-dev-ensure"], {
    cwd: repository, env, encoding: "utf8",
  });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(dryRun.stdout, "");
  const dispatcher = join(bin, "dispatch.mjs");
  await writeFile(dispatcher, `#!${process.execPath}
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const root = process.env.FIXTURE_ROOT;
const runtime = process.env.AGENTDESK_RUNTIME_ROOT;
const token = join(runtime, "agent-panel/control-token");
const prefix = join(runtime, "agent-panel/tls/fixture.invalid");
const marker = join(root, "serving");
const failure = process.env.FIXTURE_FAILURE;
const args = process.argv.slice(2);
const record = (name) => appendFileSync(join(root, "events"), name + "\\n");
switch (basename(process.argv[1])) {
  case "sh":
    assert.ok(args[0].endsWith("/tools/tailnet-dns-name.sh"));
    console.log("fixture.invalid");
    break;
  case "curl":
    assert.equal(args.at(-1), ${JSON.stringify(origin + "/@vite/client")});
    process.exit(existsSync(marker) ? 0 : 1);
  case "just":
    if (args[0] === "agent-webview-dev-stop") {
      assert.equal(args[1], "5173");
      record("stop");
      if (failure === "stop") process.exit(1);
      rmSync(marker, { force: true });
      rmSync(token, { force: true });
    } else {
      assert.equal(args[0], "agent-webview-dev-cert");
      record("cert");
      if (failure === "cert") process.exit(1);
      mkdirSync(dirname(prefix), { recursive: true });
      writeFileSync(prefix + ".crt", "certificate");
      writeFileSync(prefix + ".key", "key");
      console.log(prefix);
    }
    break;
  case "node":
    assert.ok(args[0].endsWith("/tools/build-system/ensure-js-dependencies.mjs"));
    record("dependencies");
    console.log("dependency check output must stay off origin stdout");
    break;
  case "bun":
    assert.deepEqual(args, ["run", "dev", "--port", "5173", "--strictPort"]);
    assert.equal(process.env.AGENTDESK_AGENT_PANEL_TLS_CERT, prefix + ".crt");
    assert.equal(process.env.AGENTDESK_AGENT_PANEL_TLS_KEY, prefix + ".key");
    assert.equal(process.env.AGENTDESK_AGENT_FEED_ORIGIN, "http://127.0.0.1:7682");
    record("start");
    if (failure !== "start") writeFileSync(marker, "yes");
    break;
  default: throw new Error("unexpected fixture command");
}
`, { mode: 0o755 });
  for (const name of ["sh", "curl", "just", "node", "openssl", "bun"]) {
    await symlink(dispatcher, join(bin, name));
  }
  // Shorten only the fixture's readiness wait; the production budget stays intact.
  await writeFile(join(bin, "sleep"), "#!/bin/sh\nexec /bin/sleep 0.01\n", { mode: 0o755 });
  return {
    paths,
    run: () => spawnSync("/bin/bash", ["-c", dryRun.stderr], {
      cwd: repository, env: { ...env, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8", timeout: 30_000,
    }),
    events: async () => {
      try { return (await readFile(join(root, "events"), "utf8")).trim().split("\n"); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    },
  };
}

test("healthy live server is reused without provisioning or restarting", async (t) => {
  const state = await fixture(t);
  const result = state.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, origin + "\n");
  assert.deepEqual(await state.events(), []);
});

for (const [name, options] of [
  ["missing TLS files", { tls: false }],
  ["unhealthy listener", { serving: false }],
  ["cold runtime", { serving: false, tls: false }],
]) {
  test(`${name}: stop before provisioning and publish only the ready origin`, async (t) => {
    const state = await fixture(t, options);
    const result = state.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, origin + "\n");
    assert.deepEqual(await state.events(), ["stop", "cert", "dependencies", "start"]);
  });
}

test("failed stop aborts before provisioning anything", async (t) => {
  const state = await fixture(t, { serving: false, failure: "stop" });
  const result = state.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.deepEqual(await state.events(), ["stop"]);
});

test("failed certificate provisioning never starts a server or publishes an origin", async (t) => {
  const state = await fixture(t, { serving: false, failure: "cert" });
  const result = state.run();
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.deepEqual(await state.events(), ["stop", "cert"]);
});

test("failed server readiness fails launch rather than returning an unusable origin", async (t) => {
  const state = await fixture(t, { serving: false, failure: "start" });
  const result = state.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /no Vite dev server/);
  assert.deepEqual(await state.events(), ["stop", "cert", "dependencies", "start"]);
});
