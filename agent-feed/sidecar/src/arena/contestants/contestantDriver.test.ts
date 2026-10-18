import { expect, test } from "bun:test";
import { StartLine } from "@/arena/contestants/contestantDriver";

/** Whether a promise has settled, asked without waiting on it. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

test("an arrival waits until every contestant has arrived or left, then carries the prompt", async () => {
  const line = new StartLine(3, "say one word");
  const first = line.arrive();
  expect(await settled(first)).toBe(false);
  line.leave();
  expect(await settled(first)).toBe(false);
  const last = line.arrive();
  expect(await first).toBe("say one word");
  expect(await last).toBe("say one word");
});

test("lanes opened without a prompt wait at the line until the reader gives one", async () => {
  const line = new StartLine(2, null);
  const first = line.arrive();
  const second = line.arrive();
  expect(await settled(first)).toBe(false);
  expect(line.prompted).toBe(false);
  line.give("now");
  expect(line.prompted).toBe(true);
  expect(await first).toBe("now");
  expect(await second).toBe("now");
  expect(() => line.give("again")).toThrow(/already has its prompt/);
});

test("a prompt given before the lanes are up waits for them", async () => {
  const line = new StartLine(1, null);
  line.give("early");
  const only = line.arrive();
  expect(await only).toBe("early");
});

test("a line every contestant left still opens on the prompt, and a line of one at once", async () => {
  const empty = new StartLine(1, "p");
  empty.leave();
  expect(await settled(empty.arrive())).toBe(true);
  expect(await new StartLine(1, "p").arrive()).toBe("p");
});

test("an aborted line refuses the contestants waiting at it and any still to come", async () => {
  const line = new StartLine(2, null);
  const waiting = line.arrive();
  line.abort(new Error("the run was removed"));
  await expect(waiting).rejects.toThrow(/removed/);
  await expect(line.arrive()).rejects.toThrow(/removed/);
});
