// The budgets. What matters is not that a limit exists but that it is keyed on something the caller
// cannot choose, that a refusal tells the caller how long to wait, and that a released stream slot
// really comes back.
import { expect, test } from "bun:test";
import { RateLimiter, DEFAULT_LIMITS, type Limits } from "@/ratelimit";
import { RateLimited } from "@/messages";

const small: Limits = { writes: { capacity: 3, refillPerSecond: 1 }, reads: { capacity: 2, refillPerSecond: 1 }, maxStreams: 2 };

test("a burst is allowed up to capacity, and the next one is refused", () => {
  const limiter = new RateLimiter(small, () => 0);
  for (let i = 0; i < 3; i += 1) limiter.take("a", "writes", "PUT /v1/directory/bots/mac");
  expect(() => limiter.take("a", "writes", "PUT /v1/directory/bots/mac")).toThrow(RateLimited);
});

test("a refusal says how long to wait, because a caller told only 'no' retries at once", () => {
  const limiter = new RateLimiter(small, () => 0);
  limiter.take("a", "writes", "x");
  limiter.take("a", "writes", "x");
  limiter.take("a", "writes", "x");
  try {
    limiter.take("a", "writes", "x");
    throw new Error("should have refused");
  } catch (error) {
    expect(error).toBeInstanceOf(RateLimited);
    expect((error as RateLimited).retryAfterSeconds).toBe(1);
    expect((error as RateLimited).message).toContain("writes budget");
  }
});

test("tokens come back with time, so a client that backs off recovers on its own", () => {
  let now = 0;
  const limiter = new RateLimiter(small, () => now);
  for (let i = 0; i < 3; i += 1) limiter.take("a", "writes", "x");
  expect(() => limiter.take("a", "writes", "x")).toThrow(RateLimited);
  now += 1000; // one second at one per second
  expect(() => limiter.take("a", "writes", "x")).not.toThrow();
});

test("one caller's loop cannot spend another's budget", () => {
  const limiter = new RateLimiter(small, () => 0);
  for (let i = 0; i < 3; i += 1) limiter.take("noisy", "writes", "x");
  expect(() => limiter.take("noisy", "writes", "x")).toThrow(RateLimited);
  // The quiet caller is untouched, which is the whole point of keying per caller.
  expect(() => limiter.take("quiet", "writes", "x")).not.toThrow();
  expect(() => limiter.take("quiet", "writes", "x")).not.toThrow();
  expect(() => limiter.take("quiet", "writes", "x")).not.toThrow();
});

test("reads and writes are separate budgets, so polling cannot starve a publish", () => {
  const limiter = new RateLimiter(small, () => 0);
  limiter.take("a", "reads", "GET /v1/threads");
  limiter.take("a", "reads", "GET /v1/threads");
  expect(() => limiter.take("a", "reads", "GET /v1/threads")).toThrow(RateLimited);
  // A directory publish still goes through: a panel reading hard must not stop a machine reporting.
  expect(() => limiter.take("a", "writes", "PUT /v1/directory/bots/mac")).not.toThrow();
});

test("stream slots are capped, and a released slot really comes back", () => {
  const limiter = new RateLimiter(small, () => 0);
  const first = limiter.holdStream("mac");
  const second = limiter.holdStream("mac");
  expect(() => limiter.holdStream("mac")).toThrow(RateLimited);
  // Another machine is unaffected: the cap is per caller, not global.
  const other = limiter.holdStream("oracle");
  expect(typeof other).toBe("function");
  first();
  // The slot just freed is claimable again, and claiming it means holding it.
  const third = limiter.holdStream("mac");
  expect(() => limiter.holdStream("mac")).toThrow(RateLimited);
  // Releasing twice is harmless, so a close racing a cancel cannot drive the count negative.
  first();
  second();
  third();
  other();
  expect(limiter.snapshot().streams).toEqual([]);
});

test("the default ceilings sit above what the system actually does", () => {
  // A machine holds one stream per live session: fifty on the mac when these numbers were measured.
  // The cap has to clear that with room for a restart, where old streams close while new ones open,
  // or the guard refuses the machine it exists to protect.
  expect(DEFAULT_LIMITS.maxStreams).toBeGreaterThanOrEqual(4 * 50);
  // A panel with a few tabs polls threads and a directory every few seconds, far under ten a second.
  expect(DEFAULT_LIMITS.reads.refillPerSecond).toBeGreaterThanOrEqual(5);
  // Writes only happen when a Bot changes, and a change is a handful at once.
  expect(DEFAULT_LIMITS.writes.capacity).toBeGreaterThanOrEqual(5);
  expect(DEFAULT_LIMITS.writes.refillPerSecond).toBeLessThan(1);
});
