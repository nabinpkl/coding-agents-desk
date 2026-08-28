import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installedHostAppPath, runtimePaths } from "../runtime-paths.mjs";

test("runtime defaults live outside checkout and build output", () => {
  const paths = runtimePaths({}, "/Users/fixture");
  assert.equal(paths.root, "/Users/fixture/Library/Application Support/AgentDeskRuntime");
  assert.equal(paths.gridEncoder, join(paths.root, "bin/grid-encoder"));
  assert.equal(paths.panelTlsDirectory, join(paths.root, "agent-panel/tls"));
  assert.equal(paths.panelControlTokenFile, join(paths.root, "agent-panel/control-token"));
  assert.equal(paths.parkDevControlTokenFile, join(paths.root, "park-dev/control-token"));
  assert.equal(installedHostAppPath("com.example.agentdesk.AgentDeskHost", paths),
    join(paths.root, "hosts/com.example.agentdesk.AgentDeskHost/AgentDeskHost.app"));
  assert.notEqual(installedHostAppPath("com.example.agentdesk.AgentDeskHost", paths),
    installedHostAppPath("com.example.agentdesk.AgentDeskHost.dev", paths));
});

test("one runtime-root override moves every consumer; helper override is explicit", () => {
  const paths = runtimePaths({ AGENTDESK_RUNTIME_ROOT: "/private/runtime" }, "/Users/fixture");
  assert.equal(paths.gridEncoder, "/private/runtime/bin/grid-encoder");
  assert.equal(paths.panelTlsDirectory, "/private/runtime/agent-panel/tls");
  assert.equal(paths.panelControlTokenFile, "/private/runtime/agent-panel/control-token");
  assert.equal(paths.parkDevControlTokenFile, "/private/runtime/park-dev/control-token");
  assert.equal(installedHostAppPath("example.host", paths),
    "/private/runtime/hosts/example.host/AgentDeskHost.app");
  assert.equal(runtimePaths({
    AGENTDESK_RUNTIME_ROOT: "/private/runtime",
    AGENT_FEED_GRID_ENCODER_PATH: "/private/helper/grid-encoder",
  }).gridEncoder, "/private/helper/grid-encoder");
});

test("relative paths and path-shaped bundle ids fail instead of targeting another tree", () => {
  assert.throws(() => runtimePaths({ AGENTDESK_RUNTIME_ROOT: "./.build" }), /absolute/);
  assert.throws(() => runtimePaths({ AGENT_FEED_GRID_ENCODER_PATH: "grid-encoder" }), /absolute/);
  for (const bundleId of [undefined, null, "", "../host", "a/b", ".", "..", "host id"]) {
    assert.throws(() => installedHostAppPath(bundleId), /bundle id/);
  }
});

test("the shell interface and imported configuration resolve identical paths", () => {
  const env = { ...process.env, AGENTDESK_RUNTIME_ROOT: "/private/fixture runtime" };
  delete env.AGENT_FEED_GRID_ENCODER_PATH;
  const cli = (args) => execFileSync(process.execPath,
    [new URL("../runtime-paths.mjs", import.meta.url).pathname, ...args],
    { env, encoding: "utf8" }).trim();
  const paths = runtimePaths(env);
  assert.equal(cli(["root"]), paths.root);
  assert.equal(cli(["grid-encoder"]), paths.gridEncoder);
  assert.equal(cli(["panel-tls"]), paths.panelTlsDirectory);
  assert.equal(cli(["panel-token"]), paths.panelControlTokenFile);
  assert.equal(cli(["park-token"]), paths.parkDevControlTokenFile);
  assert.equal(cli(["host-app", "example.host"]), installedHostAppPath("example.host", paths));
});

test("compiled Bun consumers resolve the durable runtime without executing the configuration CLI", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agentdesk-compiled-runtime-paths-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  await mkdir(source);
  const entry = join(source, "probe.ts");
  const binary = join(root, "probe");
  await writeFile(entry, `import { runtimePaths } from ${JSON.stringify(new URL("../runtime-paths.mjs", import.meta.url).pathname)};
process.stdout.write(JSON.stringify(runtimePaths()));`);
  execFileSync("bun", ["build", "--compile", entry, "--outfile", binary], { stdio: "pipe" });
  await rm(source, { recursive: true });
  const env = { ...process.env, AGENTDESK_RUNTIME_ROOT: join(root, "installed") };
  delete env.AGENT_FEED_GRID_ENCODER_PATH;
  const output = execFileSync(binary, { env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), runtimePaths(env));
});
