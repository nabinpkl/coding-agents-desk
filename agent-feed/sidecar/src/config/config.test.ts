import { expect, test } from "bun:test";
import { join } from "node:path";
import { runtimePaths } from "@repo/tools/runtime-paths.mjs";

test("sidecar helper discovery agrees with deployment for default and overridden runtime roots", async () => {
  for (const override of [undefined, "/private/agentdesk-test-runtime"]) {
    const env = { ...process.env };
    delete env.AGENT_FEED_GRID_ENCODER_PATH;
    delete env.AGENTDESK_RUNTIME_ROOT;
    if (override) env.AGENTDESK_RUNTIME_ROOT = override;
    const child = Bun.spawn([
      process.execPath, "-e",
      'import { config } from "./src/config/config.ts"; process.stdout.write(config.gridEncoderPath);',
    ], { cwd: join(import.meta.dir, "..", ".."), env, stdout: "pipe", stderr: "pipe" });
    const [exitCode, output, errors] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(errors).toBe("");
    expect(exitCode).toBe(0);
    expect(output).toBe(runtimePaths(env).gridEncoder);
  }
});
