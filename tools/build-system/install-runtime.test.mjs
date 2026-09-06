import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installHelper, installHostApp } from "./install-runtime.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "agentdesk-runtime-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const build = join(root, "build");
  const runtime = join(root, "runtime with spaces");
  await mkdir(build);
  return { root, build, runtime };
}

test("installed helper runs after the complete disposable build tree is deleted", async (t) => {
  const { build, runtime } = await fixture(t);
  const source = join(build, "grid-encoder");
  const destination = join(runtime, "bin/grid-encoder");
  await writeFile(source, "#!/bin/sh\nprintf 'installed helper\\n'\n", { mode: 0o755 });
  assert.equal((await installHelper({ source, destination })).changed, true);
  await rm(build, { recursive: true });
  assert.equal(execFileSync(destination, { encoding: "utf8" }), "installed helper\n");
  assert.equal((await lstat(destination)).isSymbolicLink(), false);
  assert.equal((await stat(join(runtime, "bin"))).mode & 0o777, 0o700);
});

test("an identical helper keeps its runtime identity; a changed helper gets a new one", async (t) => {
  const { build, runtime } = await fixture(t);
  const source = join(build, "grid-encoder");
  const destination = join(runtime, "grid-encoder");
  await writeFile(source, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await installHelper({ source, destination });
  const previous = await stat(destination);
  assert.equal((await installHelper({ source, destination })).changed, false);
  assert.equal((await stat(destination)).mtimeMs, previous.mtimeMs);
  await writeFile(source, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.equal((await installHelper({ source, destination })).changed, true);
  assert.ok((await stat(destination)).mtimeMs > previous.mtimeMs);
});

test("missing, empty, non-executable or symlink candidates cannot replace a working helper", async (t) => {
  const { build, runtime } = await fixture(t);
  const source = join(build, "grid-encoder");
  const destination = join(runtime, "grid-encoder");
  await writeFile(source, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await installHelper({ source, destination });
  const installed = await readFile(destination);
  await rm(source);
  await assert.rejects(installHelper({ source, destination }), /ENOENT/);
  await writeFile(source, "", { mode: 0o755 });
  await assert.rejects(installHelper({ source, destination }), /non-empty executable/);
  await writeFile(source, "bad candidate");
  await chmod(source, 0o644);
  await assert.rejects(installHelper({ source, destination }), /non-empty executable/);
  await rm(source);
  await symlink(destination, source);
  await assert.rejects(installHelper({ source, destination }), /non-empty executable/);
  assert.deepEqual(await readFile(destination), installed);
});

test("an existing runtime symlink is refused without following or replacing its target", async (t) => {
  const { build, runtime } = await fixture(t);
  const source = join(build, "grid-encoder");
  const destination = join(runtime, "grid-encoder");
  await writeFile(source, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await mkdir(runtime);
  await symlink(source, destination);
  await assert.rejects(installHelper({ source, destination }), /symlink/);
  assert.equal(await readlink(destination), source);
});

test("a compiler failure does not replace the last complete build or installed helper", async (t) => {
  const { root, build, runtime } = await fixture(t);
  const source = join(build, "grid-encoder");
  const destination = join(runtime, "grid-encoder");
  await writeFile(source, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await installHelper({ source, destination });
  const original = await readFile(source);
  // The build script skips swiftc when its output is already newer than every source, so a
  // freshly written binary would make this test assert nothing: there would be no compile to
  // fail. Age it past the sources to put the build genuinely out of date.
  await utimes(source, new Date(0), new Date(0));
  const bin = join(root, "fake-tools");
  await mkdir(bin);
  await writeFile(join(bin, "swiftc"), `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then shift; printf 'partial binary' > "$1"; exit 23; fi
  shift
done
exit 24
`, { mode: 0o755 });
  assert.throws(() => execFileSync("/bin/sh", [
    new URL("../build-grid-encoder.sh", import.meta.url).pathname, source,
  ], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" }), { status: 23 });
  assert.deepEqual(await readFile(source), original);
  assert.deepEqual(await readFile(destination), original);
  assert.deepEqual(await readdir(build), ["grid-encoder"]);
});

async function signedApp(build, bundleId = "test.agentdesk.host", wait = false) {
  const source = join(build, "AgentDeskHost.app");
  await mkdir(join(source, "Contents/MacOS"), { recursive: true });
  await mkdir(join(source, "Contents/Resources"));
  await writeFile(join(source, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleExecutable</key><string>AgentDeskHost</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
  execFileSync("/usr/bin/cc", ["-x", "c", "-", "-o", join(source, "Contents/MacOS/AgentDeskHost")],
    { input: wait ? "#include <unistd.h>\nint main(void) { pause(); return 0; }\n" : "int main(void) { return 0; }\n",
      stdio: ["pipe", "pipe", "pipe"] });
  await writeFile(join(source, "Contents/Resources/payload"), "bundled resource");
  await symlink("payload", join(source, "Contents/Resources/current"));
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", source], { stdio: "pipe" });
  return source;
}

test("copied host preserves signature and resources after its build tree is removed", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const { build, runtime } = await fixture(t);
  const source = await signedApp(build);
  const destination = join(runtime, "AgentDeskHost.app");
  await installHostApp({ source, destination, bundleId: "test.agentdesk.host" });
  await rm(build, { recursive: true });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", destination]);
  assert.equal(await readlink(join(destination, "Contents/Resources/current")), "payload");
  assert.equal(await readFile(join(destination, "Contents/Resources/current"), "utf8"), "bundled resource");
  execFileSync(join(destination, "Contents/MacOS/AgentDeskHost"));
});

test("invalid identity and broken signatures leave the existing installed app intact", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const { build, runtime } = await fixture(t);
  const source = await signedApp(build);
  const destination = join(runtime, "AgentDeskHost.app");
  await installHostApp({ source, destination, bundleId: "test.agentdesk.host" });
  await assert.rejects(installHostApp({ source, destination, bundleId: "other.host" }), /bundle id/);
  await writeFile(join(source, "Contents/Resources/payload"), "corrupted candidate");
  await assert.rejects(installHostApp({ source, destination, bundleId: "test.agentdesk.host" }), /codesign/);
  assert.equal(await readFile(join(destination, "Contents/Resources/payload"), "utf8"), "bundled resource");
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", destination]);
});

test("installation refuses a running host without stopping it", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const { build, runtime } = await fixture(t);
  const source = await signedApp(build, "test.agentdesk.host", true);
  const destination = join(runtime, "AgentDeskHost.app");
  await installHostApp({ source, destination, bundleId: "test.agentdesk.host" });
  const child = spawn(join(destination, "Contents/MacOS/AgentDeskHost"), [], { stdio: "ignore" });
  await once(child, "spawn");
  try {
    await assert.rejects(installHostApp({ source, destination, bundleId: "test.agentdesk.host" }), /host is running/);
    assert.equal(child.exitCode, null);
  } finally {
    const exit = once(child, "exit");
    child.kill();
    await exit;
  }
});

test("bundle links into disposable build output are refused", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const { build, runtime } = await fixture(t);
  const source = await signedApp(build);
  await writeFile(join(build, "external-resource"), "still in build");
  await symlink(join(build, "external-resource"), join(source, "Contents/Resources/external"));
  execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", source], { stdio: "pipe" });
  await assert.rejects(installHostApp({ source, destination: join(runtime, "AgentDeskHost.app"),
    bundleId: "test.agentdesk.host" }), /symlink points outside/);
});
