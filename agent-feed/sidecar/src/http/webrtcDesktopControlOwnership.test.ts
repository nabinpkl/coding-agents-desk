import { describe, expect, test } from "bun:test";
import { DesktopControlOwnership } from "./webrtcDesktopControlOwnership.ts";

describe("DesktopControlOwnership", () => {
  test("grants once, revokes the previous owner, and advances a monotonic epoch", () => {
    const ownership = new DesktopControlOwnership<string>();
    expect(ownership.acquire("a")).toEqual({
      changed: true, epoch: 1, previous: null, current: "a",
    });
    expect(ownership.acquire("a")).toEqual({
      changed: false, epoch: 1, previous: "a", current: "a",
    });
    expect(ownership.acquire("b")).toEqual({
      changed: true, epoch: 2, previous: "a", current: "b",
    });
    expect(ownership.owner).toBe("b");
  });

  test("ignores stale releases and revokes only the current owner", () => {
    const ownership = new DesktopControlOwnership<string>();
    ownership.acquire("a");
    ownership.acquire("b");
    expect(ownership.release("a").changed).toBe(false);
    expect(ownership.owner).toBe("b");
    expect(ownership.release("b")).toEqual({
      changed: true, epoch: 3, previous: "b", current: null,
    });
  });
});
