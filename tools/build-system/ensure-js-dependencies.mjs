#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const managerDefinitions = [
  {
    manager: "npm",
    locks: ["npm-shrinkwrap.json", "package-lock.json"],
    installArguments: ["ci"],
  },
  {
    manager: "bun",
    locks: ["bun.lock", "bun.lockb"],
    installArguments: ["install", "--frozen-lockfile"],
  },
  {
    manager: "pnpm",
    locks: ["pnpm-lock.yaml"],
    installArguments: ["install", "--frozen-lockfile"],
  },
];

async function existingFile(path) {
  try {
    const metadata = await stat(path);
    return metadata.isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function existingDirectory(path) {
  try {
    const metadata = await stat(path);
    return metadata.isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function detectManager(projectDirectory) {
  const matches = [];
  for (const definition of managerDefinitions) {
    for (const lock of definition.locks) {
      const lockPath = resolve(projectDirectory, lock);
      if (await existingFile(lockPath)) {
        matches.push({ ...definition, lock, lockPath });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one supported lockfile in ${projectDirectory}; found `
      + matches.map(({ lock }) => lock).join(", "),
    );
  }
  return matches[0];
}

function defaultRun(command, arguments_, options) {
  return spawnSync(command, arguments_, options);
}

function requireSuccessfulCommand(result, description) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${description} failed with status ${result.status}`);
  }
}

async function dependencyHash({ projectDirectory, packagePath, lockPath, manager, version }) {
  const hash = createHash("sha256");
  hash.update(resolve(projectDirectory));
  hash.update("\0");
  hash.update(manager);
  hash.update("\0");
  hash.update(version);
  hash.update("\0");
  for (const path of [packagePath, lockPath]) {
    hash.update(basename(path));
    hash.update("\0");
    hash.update(await readFile(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function ensureJSDependencies({
  name,
  projectDirectory,
  stateDirectory,
  run = defaultRun,
  install,
  managerVersion,
}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`dependency-state name must be lowercase kebab-case: ${name}`);
  }
  const project = resolve(projectDirectory);
  const state = resolve(stateDirectory);
  const packagePath = resolve(project, "package.json");
  if (!await existingFile(packagePath)) {
    throw new Error(`package.json is missing: ${packagePath}`);
  }

  const definition = await detectManager(project);
  let version = managerVersion;
  if (!version) {
    const result = run(definition.manager, ["--version"], {
      cwd: project,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    requireSuccessfulCommand(result, `${definition.manager} --version`);
    version = result.stdout.trim();
  }

  const hash = await dependencyHash({
    projectDirectory: project,
    packagePath,
    lockPath: definition.lockPath,
    manager: definition.manager,
    version,
  });
  const stampPath = resolve(state, `${name}.sha256`);
  const installedHash = await readFile(stampPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const modulesPath = resolve(project, "node_modules");
  if (installedHash.trim() === hash && await existingDirectory(modulesPath)) {
    return { installed: false, manager: definition.manager, hash };
  }

  if (install) {
    await install({
      manager: definition.manager,
      arguments: definition.installArguments,
      projectDirectory: project,
    });
  } else {
    const result = run(definition.manager, definition.installArguments, {
      cwd: project,
      stdio: "inherit",
    });
    requireSuccessfulCommand(result, `${definition.manager} dependency installation`);
  }
  if (!await existingDirectory(modulesPath)) {
    throw new Error(`${definition.manager} completed without creating ${modulesPath}`);
  }

  await mkdir(state, { recursive: true });
  const temporaryStamp = resolve(state, `.${name}.${process.pid}.tmp`);
  await writeFile(temporaryStamp, `${hash}\n`);
  await rename(temporaryStamp, stampPath);
  return { installed: true, manager: definition.manager, hash };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [name, projectDirectory, stateDirectory] = process.argv.slice(2);
  if (!name || !projectDirectory || !stateDirectory) {
    console.error(
      "usage: ensure-js-dependencies.mjs <name> <project-directory> <state-directory>",
    );
    process.exitCode = 1;
  } else {
    try {
      const result = await ensureJSDependencies({ name, projectDirectory, stateDirectory });
      console.log(
        `ensure-js-dependencies: ${name} manager=${result.manager} `
        + `${result.installed ? "installed" : "unchanged"}`,
      );
    } catch (error) {
      console.error(`ensure-js-dependencies: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
