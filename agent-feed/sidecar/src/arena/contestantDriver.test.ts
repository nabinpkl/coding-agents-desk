import { expect, test } from "bun:test";
import { StartLine } from "@/arena/contestantDriver";

/** Whether a promise has settled, asked without waiting on it. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

test("an arrival waits until every contestant has arrived or left", async () => {
  const line = new StartLine(3);
  const first = line.arrive();
  expect(await settled(first)).toBe(false);
  line.leave();
  expect(await settled(first)).toBe(false);
  const last = line.arrive();
  expect(await settled(first)).toBe(true);
  expect(await settled(last)).toBe(true);
});

test("a line every contestant left is open, and so is a line of one", async () => {
  const empty = new StartLine(1);
  empty.leave();
  expect(await settled(empty.arrive())).toBe(true);
  expect(await settled(new StartLine(1).arrive())).toBe(true);
});
