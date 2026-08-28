import { execFileSync } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, utimes } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

async function optionalStat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function isWithin(root, path) {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function validatePaths(source, destination) {
  if (!isAbsolute(source) || !isAbsolute(destination)) {
    throw new Error("runtime source and destination must be absolute paths");
  }
  const a = resolve(source);
  const b = resolve(destination);
  if (a === dirname(a) || b === dirname(b) || isWithin(a, b) || isWithin(b, a)) {
    throw new Error("runtime source and destination must be separate, non-root paths");
  }
}

async function validateDestination(destination) {
  const previous = await optionalStat(destination);
  if (previous?.isSymbolicLink()) throw new Error(`refusing runtime symlink: ${destination}`);
  return previous;
}

/** Copy then rename on the destination volume. A build never writes the running executable. */
export async function installHelper({ source, destination }) {
  validatePaths(source, destination);
  const candidate = await lstat(source);
  if (!candidate.isFile() || candidate.size === 0 || (candidate.mode & 0o111) === 0) {
    throw new Error(`helper candidate must be a non-empty executable file: ${source}`);
  }
  const previous = await validateDestination(destination);
  if (previous && !previous.isFile()) throw new Error(`runtime helper is not a file: ${destination}`);
  if (previous && (previous.mode & 0o111) !== 0
    && (await readFile(source)).equals(await readFile(destination))) {
    return { changed: false, destination };
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(destination), ".helper-install-"));
  try {
    const staged = join(staging, "grid-encoder");
    await copyFile(source, staged);
    await chmod(staged, 0o755);
    // Pool generations use mtime. Distinct installs must remain distinct even if two
    // builds finish in one filesystem clock tick; identical binaries above keep it.
    const modified = new Date(Math.max(Date.now(), (previous?.mtimeMs ?? 0) + 1));
    await utimes(staged, modified, modified);
    await rename(staged, destination);
    return { changed: true, destination };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function verifyContainedSymlinks(app, directory = app) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = resolve(directory, await readlink(path));
      if (!isWithin(app, target)) throw new Error(`host bundle symlink points outside its app: ${path}`);
    } else if (entry.isDirectory()) {
      await verifyContainedSymlinks(app, path);
    }
  }
}

export async function verifyHostApp(source, bundleId) {
  const actual = execFileSync("/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", join(source, "Contents/Info.plist")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (actual !== bundleId) throw new Error(`host bundle id ${actual} does not match ${bundleId}`);
  const executable = execFileSync("/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleExecutable", join(source, "Contents/Info.plist")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (executable !== "AgentDeskHost") throw new Error(`unexpected host executable: ${executable}`);
  await verifyContainedSymlinks(resolve(source));
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", source], { stdio: "pipe" });
}

/** Install a complete signed bundle without editing its contents or ending its PTY children. */
export async function installHostApp({ source, destination, bundleId }) {
  validatePaths(source, destination);
  if (basename(destination) !== "AgentDeskHost.app" || !(await lstat(source)).isDirectory()) {
    throw new Error("host installation requires a directory and an AgentDeskHost.app destination");
  }
  const previous = await validateDestination(destination);
  if (previous && !previous.isDirectory()) throw new Error(`installed host is not a directory: ${destination}`);
  await verifyHostApp(source, bundleId);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(destination), ".host-install-"));
  const staged = join(staging, "AgentDeskHost.app");
  const backup = join(staging, "previous.app");
  let keepForRecovery = false;
  try {
    // ditto preserves bundle symlinks, extended attributes and signature resources.
    // A symlink to DerivedData would still disappear when the build cache is removed.
    execFileSync("/usr/bin/ditto", [source, staged], { stdio: "pipe" });
    await verifyHostApp(staged, bundleId);
    const running = execFileSync("/bin/sh", [
      fileURLToPath(new URL("../exact-executable-pids.sh", import.meta.url)),
      join(destination, "Contents/MacOS/AgentDeskHost"),
    ], { encoding: "utf8" }).trim();
    if (running) throw new Error(`installed host is running (pid ${running}); stop it before installation`);
    if (previous) await rename(destination, backup);
    try {
      await rename(staged, destination);
    } catch (error) {
      if (previous) {
        try {
          await rename(backup, destination);
        } catch (rollbackError) {
          keepForRecovery = true;
          throw new AggregateError([error, rollbackError], `host rollback failed; previous app retained at ${backup}`);
        }
      }
      throw error;
    }
    return { changed: true, destination };
  } finally {
    if (!keepForRecovery) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [kind, source, destination, bundleId, ...extra] = process.argv.slice(2);
  let result;
  if (kind === "helper" && source && destination && !bundleId) {
    result = await installHelper({ source, destination });
  } else if (kind === "host" && source && destination && bundleId && extra.length === 0) {
    result = await installHostApp({ source, destination, bundleId });
  } else if (kind === "verify-host" && source && destination && !bundleId) {
    await verifyHostApp(source, destination);
    process.stdout.write(`verified ${source}\n`);
  } else {
    throw new Error("usage: install-runtime.mjs helper <source> <destination> | host <source> <destination> <bundle-id> | verify-host <source> <bundle-id>");
  }
  if (result) process.stdout.write(`${result.changed ? "installed" : "unchanged"} ${result.destination}\n`);
}
