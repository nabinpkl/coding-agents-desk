import { expect, test } from "bun:test";
import { join } from "node:path";
import { runtimePaths } from "../../../tools/runtime-paths.mjs";

test("the sidecar snapshots then removes its control capability from tool child environments", async () => {
  const child = Bun.spawn([
    process.execPath,
    "-e",
    [
      'import { config } from "./src/config.ts";',
      'process.stdout.write(JSON.stringify({ token: config.controlToken, inherited: process.env.AGENT_FEED_CONTROL_TOKEN ?? null }));',
    ].join(""),
  ], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, AGENT_FEED_CONTROL_TOKEN: "test-control-capability" },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, output, errorOutput] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(errorOutput).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(output)).toEqual({
    token: "test-control-capability",
    inherited: null,
  });
});

test("sidecar helper discovery agrees with deployment for default and overridden runtime roots", async () => {
  for (const override of [undefined, "/private/agentdesk-test-runtime"]) {
    const env = { ...process.env };
    delete env.AGENT_FEED_GRID_ENCODER_PATH;
    delete env.AGENTDESK_RUNTIME_ROOT;
    if (override) env.AGENTDESK_RUNTIME_ROOT = override;
    const child = Bun.spawn([
      process.execPath, "-e",
      'import { config } from "./src/config.ts"; process.stdout.write(config.gridEncoderPath);',
    ], { cwd: join(import.meta.dir, ".."), env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, output, errors] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(errors).toBe("");
    expect(exitCode).toBe(0);
    expect(output).toBe(runtimePaths(env).gridEncoder);
  }
});
