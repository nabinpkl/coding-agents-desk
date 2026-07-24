import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { ensureJSDependencies } from "./ensure-js-dependencies.mjs";

async function fixture(run) {
  const root = await mkdtemp(resolve(tmpdir(), "agentdesk-js-dependencies-"));
  const project = resolve(root, "project");
  const state = resolve(root, "state");
  await mkdir(project, { recursive: true });
  await writeFile(resolve(project, "package.json"), '{"name":"fixture"}\n');
  await writeFile(resolve(project, "package-lock.json"), '{"lockfileVersion":3}\n');
  try {
    await run({ project, state });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function installer(counter) {
  return async ({ projectDirectory }) => {
    counter.count += 1;
    await mkdir(resolve(projectDirectory, "node_modules"), { recursive: true });
  };
}

test("installs once and retains matching dependency state", async () => {
  await fixture(async ({ project, state }) => {
    const calls = { count: 0 };
    const options = {
      name: "fixture",
      projectDirectory: project,
      stateDirectory: state,
      managerVersion: "10.0.0",
      install: installer(calls),
    };

    assert.equal((await ensureJSDependencies(options)).installed, true);
    assert.equal((await ensureJSDependencies(options)).installed, false);
    assert.equal(calls.count, 1);
  });
});

test("lockfile, manager version, and missing node_modules invalidate state", async () => {
  await fixture(async ({ project, state }) => {
    const calls = { count: 0 };
    const base = {
      name: "fixture",
      projectDirectory: project,
      stateDirectory: state,
      install: installer(calls),
    };
    await ensureJSDependencies({ ...base, managerVersion: "10.0.0" });

    await writeFile(resolve(project, "package-lock.json"), '{"lockfileVersion":3,"changed":true}\n');
    await ensureJSDependencies({ ...base, managerVersion: "10.0.0" });
    await ensureJSDependencies({ ...base, managerVersion: "11.0.0" });
    await rm(resolve(project, "node_modules"), { recursive: true, force: true });
    await ensureJSDependencies({ ...base, managerVersion: "11.0.0" });

    assert.equal(calls.count, 4);
  });
});

test("failed installation never records successful state", async () => {
  await fixture(async ({ project, state }) => {
    await assert.rejects(
      ensureJSDependencies({
        name: "fixture",
        projectDirectory: project,
        stateDirectory: state,
        managerVersion: "10.0.0",
        install: async () => {
          throw new Error("install failed");
        },
      }),
      /install failed/,
    );
    await assert.rejects(readFile(resolve(state, "fixture.sha256")), { code: "ENOENT" });
  });
});

test("requires one supported lockfile", async () => {
  await fixture(async ({ project, state }) => {
    await writeFile(resolve(project, "bun.lock"), "");
    await assert.rejects(
      ensureJSDependencies({
        name: "fixture",
        projectDirectory: project,
        stateDirectory: state,
        managerVersion: "1.0.0",
        install: async () => {},
      }),
      /exactly one supported lockfile/,
    );
  });
});
