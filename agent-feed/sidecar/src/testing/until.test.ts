import { expect, jest, test } from "bun:test";

import { drained, settleOnFakeTime, until } from "@/testing/until";

test("returns once the condition holds, however many polls that takes", async () => {
  let asked = 0;
  await until(() => ++asked === 3, "the third poll");
  expect(asked).toBe(3);
});

test("waits for an async condition", async () => {
  let asked = 0;
  await until(async () => ++asked === 2, "the second poll");
  expect(asked).toBe(2);
});

test("fails naming what never happened", async () => {
  await expect(until(() => false, "a reply that never comes", 20)).rejects.toThrow(
    "timed out after 20ms waiting for a reply that never comes",
  );
});

test("drained comes after promise turns queued before it, and the turns they queue", async () => {
  const order: string[] = [];
  void Promise.resolve()
    .then(() => order.push("first"))
    .then(() => order.push("second"));
  await drained();
  expect(order).toEqual(["first", "second"]);
});

test("settleOnFakeTime runs the clock as far as the work needs, and no further", async () => {
  jest.useFakeTimers();
  try {
    const started = Date.now();
    const work = (async () => {
      for (let polls = 0; polls < 3; polls += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      return "done";
    })();
    expect(await settleOnFakeTime(work, 10)).toBe("done");
    expect(Date.now() - started).toBe(300);
  } finally {
    jest.useRealTimers();
  }
});

test("settleOnFakeTime gives up rather than hanging on work that never settles", async () => {
  jest.useFakeTimers();
  try {
    await expect(settleOnFakeTime(new Promise(() => {}), 10, 5)).rejects.toThrow("still unsettled after 5 steps");
  } finally {
    jest.useRealTimers();
  }
});
