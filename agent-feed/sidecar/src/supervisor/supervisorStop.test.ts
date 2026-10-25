import { afterEach, expect, jest, test } from "bun:test";
import { stopChild } from "@/supervisor/supervisorStop";

// The grace is a timer, so these run on fake time: the test moves the clock past it rather than
// waiting it out. The child is a real process, and its exit arrives on its own.
afterEach(() => {
  jest.useRealTimers();
});

/**
 * A child that has its SIGTERM handler installed before it says so, so the signal cannot arrive
 * while it is still starting up and be taken by the default action instead.
 */
async function spawnChild(script: string) {
  const child = Bun.spawn({
    // Kept alive by an open stdin it reads, which ends only with the process.
    cmd: [process.execPath, "-e", `${script}; console.log("ready"); process.stdin.resume();`],
    stdin: "pipe",
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
  jest.useFakeTimers();
  const logs: string[] = [];
  const started = Date.now();

  stopChild(child, (message) => logs.push(message), 200);
  jest.advanceTimersByTime(200);
  await child.exited;

  expect(child.signalCode).toBe("SIGKILL");
  expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  expect(logs).toEqual([`sidecar ${child.pid} did not stop within 200ms of SIGTERM; sending SIGKILL`]);
});

test("a child that stops when asked is not killed, and nothing is said", async () => {
  const child = await spawnChild(`process.on("SIGTERM", () => process.exit(0))`);
  jest.useFakeTimers();
  const logs: string[] = [];

  stopChild(child, (message) => logs.push(message), 200);
  await child.exited;
  // Well past the grace: a timer the exit failed to cancel would have fired by now.
  jest.advanceTimersByTime(1_000);

  expect(child.exitCode).toBe(0);
  expect(child.signalCode).toBeNull();
  expect(logs).toEqual([]);
});
