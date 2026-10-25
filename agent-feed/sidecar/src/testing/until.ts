// How a sidecar test waits: for a condition it can observe (`until`), for in-memory work to finish
// (`drained`), or for fake time to carry code that owns its own timer (`settleOnFakeTime`). Never for
// a length of time.
//
// A fixed wait (`Bun.sleep(50)`, a promise around `setTimeout`) is a guess about how fast the
// machine is. It holds on a quiet machine and loses the race on a busy one. Measured 2026-10-19:
// with the panel's suite running beside it, two tests that waited 10ms for the Bot registry failed,
// and with `bun test --parallel` a different test waiting 80ms failed on each run. Check 10 of
// `tools/agent-feed-fitness.sh` refuses a timer in any test, harness or fixture but this file.

import { jest } from "bun:test";

/**
 * Polls `condition` until it holds, and fails naming `what` never happened once the budget is spent.
 *
 * The budget is a ceiling, not a delay: a satisfied condition returns on the next poll, so a
 * generous budget costs nothing when the code works. It stays under Bun's five-second limit for a
 * test, so a failure names what never happened rather than only that the test ran out of time.
 *
 * Not for a test under fake timers (`jest.useFakeTimers()`): its clock moves only when the test
 * moves it, so poll nothing there and advance the timers instead.
 */
export async function until(
  condition: () => boolean | Promise<boolean>,
  what: string,
  budgetMs = 4_000,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${budgetMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Resolves on the next pass of the event loop, after every promise turn already queued and every
 * turn those queue in turn. An order, not a length of time: exact for work done in memory, such as
 * a fake's callbacks or a chain of awaits, and no help with real I/O, which is what `until` is for.
 * It is how a test that expects NOTHING from in-memory work knows that work is over.
 */
export function drained(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Moves fake time forward in `stepMs` steps until `work` settles, finishing the promise turns each
 * step sets off, and gives back what it settled to. For code that polls or gives up on its own
 * timer, where the test would otherwise sit out the real wait: the clock runs as far as the code
 * needs and no further. The step is how finely time moves, not a guess at how long anything takes;
 * any step no longer than the code's own poll lands on the same outcome.
 *
 * Needs `jest.useFakeTimers()` first. Bounded, because on fake time Bun's own limit for a test does
 * not run either, and work that never settles would otherwise hang the suite.
 */
export async function settleOnFakeTime<T>(work: Promise<T>, stepMs: number, maxSteps = 10_000): Promise<T> {
  let settled = false;
  // Both outcomes handled here, so work that fails while the clock is still moving is not reported
  // as an unhandled rejection before the caller gets it back.
  work.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let step = 0; !settled; step += 1) {
    if (step === maxSteps) throw new Error(`still unsettled after ${maxSteps} steps of ${stepMs}ms of fake time`);
    await drained();
    if (!settled) jest.advanceTimersByTime(stepMs);
  }
  return work;
}

/** Short enough that a condition met just after a poll costs the test almost nothing. */
const POLL_MS = 5;
