import { expect, test } from "bun:test";
import { stopChild } from "@/supervisorStop";

/**
 * A child that has its SIGTERM handler installed before it says so, so the signal cannot arrive
 * while it is still starting up and be taken by the default action instead.
 */
async function spawnChild(script: string) {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `${script}; console.log("ready"); setInterval(() => {}, 1000);`],
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain("ready");
  reader.releaseLock();
  return child;
}

// The 2026-10-02 orphan: a sidecar whose JavaScript never runs its SIGTERM handler. Catching the
// signal and doing nothing is that, seen from outside.
test("a child that does not answer SIGTERM is killed once the grace runs out", async () => {
  const child = await spawnChild(`process.on("SIGTERM", () => {})`);
  const logs: string[] = [];
  const started = Date.now();

  stopChild(child, (message) => logs.push(message), 200);
  await child.exited;

  expect(child.signalCode).toBe("SIGKILL");
  expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  expect(logs).toEqual([`sidecar ${child.pid} did not stop within 200ms of SIGTERM; sending SIGKILL`]);
});

test("a child that stops when asked is not killed, and nothing is said", async () => {
  const child = await spawnChild(`process.on("SIGTERM", () => process.exit(0))`);
  const logs: string[] = [];

  stopChild(child, (message) => logs.push(message), 200);
  await child.exited;
  await Bun.sleep(300);

  expect(child.exitCode).toBe(0);
  expect(child.signalCode).toBeNull();
  expect(logs).toEqual([]);
});
