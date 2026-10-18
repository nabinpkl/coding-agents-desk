import { describe, expect, it, vi } from "vitest";
import { runWithFinally } from "@/hooks/state/runWithFinally";

describe("runWithFinally", () => {
  it("answers with what the work resolved to, after cleaning up once", async () => {
    const order: string[] = [];
    const answer = await runWithFinally(async () => {
      order.push("work");
      return 7;
    }, () => order.push("cleanup"));
    expect(answer).toBe(7);
    expect(order).toEqual(["work", "cleanup"]);
  });

  it("cleans up and rethrows when the work throws", async () => {
    const cleanup = vi.fn();
    const failure = new Error("refused");
    await expect(runWithFinally(async () => {
      throw failure;
    }, cleanup)).rejects.toBe(failure);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("cleans up only after the work has settled, not when it starts", async () => {
    let finish!: () => void;
    const cleanup = vi.fn();
    const running = runWithFinally(() => new Promise<void>((resolve) => { finish = resolve; }), cleanup);
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
    finish();
    await running;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
