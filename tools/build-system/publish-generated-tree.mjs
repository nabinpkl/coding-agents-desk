#!/usr/bin/env node

import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function validateRelativePath(path) {
  if (
    path === ""
    || isAbsolute(path)
    || path === ".."
    || path.startsWith(`..${sep}`)
  ) {
    throw new Error(`preserved path must be relative to the destination: ${path}`);
  }
}

async function readEntry(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function walk(root) {
  const files = new Map();
  const directories = new Set([""]);

  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`generated trees cannot contain symbolic links: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        directories.add(relativePath);
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.set(relativePath, absolutePath);
      } else {
        throw new Error(`unsupported generated-tree entry: ${absolutePath}`);
      }
    }
  }

  await visit(root, "");
  return { files, directories };
}

async function filesEqual(left, right) {
  const [leftStat, rightStat] = await Promise.all([lstat(left), lstat(right)]);
  if (!rightStat.isFile() || leftStat.size !== rightStat.size) return false;
  const [leftContent, rightContent] = await Promise.all([readFile(left), readFile(right)]);
  return leftContent.equals(rightContent);
}

async function replaceFile(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  const sourceStat = await lstat(source);
  const temporary = resolve(
    dirname(destination),
    `.${parse(destination).base}.agentdesk-${process.pid}-${randomUUID()}`,
  );
  try {
    await copyFile(source, temporary);
    await chmod(temporary, sourceStat.mode & 0o777);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function publishGeneratedTree({
  sourceDirectory,
  destinationDirectory,
  preserve = [],
}) {
  const source = resolve(sourceDirectory);
  const destination = resolve(destinationDirectory);
  if (source === parse(source).root || destination === parse(destination).root) {
    throw new Error("generated-tree roots cannot be filesystem roots");
  }
  if (isInside(source, destination) || isInside(destination, source)) {
    throw new Error("generated-tree source and destination cannot contain one another");
  }

  const sourceStat = await readEntry(source);
  if (!sourceStat?.isDirectory()) {
    throw new Error(`generated-tree source is not a directory: ${source}`);
  }

  const preserved = new Set(preserve);
  for (const path of preserved) validateRelativePath(path);

  const sourceTree = await walk(source);
  if (sourceTree.files.size === 0) {
    throw new Error(`generated-tree source has no files: ${source}`);
  }

  await mkdir(destination, { recursive: true });
  const destinationTree = await walk(destination);
  let changed = 0;
  let unchanged = 0;
  let removed = 0;

  const orderedSourceDirectories = [...sourceTree.directories]
    .filter(Boolean)
    .sort((left, right) => left.split("/").length - right.split("/").length);
  for (const relativePath of orderedSourceDirectories) {
    const destinationPath = resolve(destination, relativePath);
    const entry = await readEntry(destinationPath);
    if (entry && !entry.isDirectory()) {
      await rm(destinationPath, { recursive: true, force: true });
      removed += 1;
    }
    await mkdir(destinationPath, { recursive: true });
  }

  for (const [relativePath, sourcePath] of sourceTree.files) {
    const destinationPath = resolve(destination, relativePath);
    const entry = await readEntry(destinationPath);
    if (entry?.isFile() && await filesEqual(sourcePath, destinationPath)) {
      unchanged += 1;
      continue;
    }
    if (entry) await rm(destinationPath, { recursive: true, force: true });
    await replaceFile(sourcePath, destinationPath);
    changed += 1;
  }

  for (const [relativePath, destinationPath] of destinationTree.files) {
    if (sourceTree.files.has(relativePath) || preserved.has(relativePath)) continue;
    await rm(destinationPath, { force: true });
    removed += 1;
  }

  const hasPreservedDescendant = (relativeDirectory) =>
    [...preserved].some((path) => path.startsWith(`${relativeDirectory}/`));
  const staleDirectories = [...destinationTree.directories]
    .filter(Boolean)
    .filter((path) => !sourceTree.directories.has(path))
    .filter((path) => !hasPreservedDescendant(path))
    .sort((left, right) => right.split("/").length - left.split("/").length);
  for (const relativePath of staleDirectories) {
    const destinationPath = resolve(destination, relativePath);
    const entries = await readdir(destinationPath).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error;
    });
    if (entries.length === 0) {
      await rm(destinationPath, { recursive: true, force: true });
      removed += 1;
    }
  }

  return { changed, unchanged, removed };
}

function parseArguments(arguments_) {
  const positional = [];
  const preserve = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--preserve") {
      const path = arguments_[index + 1];
      if (!path) throw new Error("--preserve requires a relative path");
      preserve.push(path);
      index += 1;
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 2) {
    throw new Error(
      "usage: publish-generated-tree.mjs <source-directory> <destination-directory> "
      + "[--preserve <relative-path>]",
    );
  }
  return {
    sourceDirectory: positional[0],
    destinationDirectory: positional[1],
    preserve,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await publishGeneratedTree(parseArguments(process.argv.slice(2)));
    console.log(
      `publish-generated-tree: changed=${result.changed} `
      + `unchanged=${result.unchanged} removed=${result.removed}`,
    );
  } catch (error) {
    console.error(`publish-generated-tree: ${error.message}`);
    process.exitCode = 1;
  }
}
