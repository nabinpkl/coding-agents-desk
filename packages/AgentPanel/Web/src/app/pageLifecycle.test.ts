import { describe, expect, it, vi } from "vitest";
import { installPagehideLifecycle } from "./pageLifecycle";

describe("pagehide lifecycle", () => {
  it("ends the current terminal context before destroying the bridge", () => {
    const order: string[] = [];
    const lifecycle = installPagehideLifecycle({
      endActiveTerminalContext: () => order.push("context-ended"),
      destroy: () => order.push("destroy"),
    });

    window.dispatchEvent(new Event("pagehide"));

    expect(order).toEqual(["context-ended", "destroy"]);
    lifecycle.remove();
  });

  it("removes its event listener", () => {
    const destroy = vi.fn();
    const lifecycle = installPagehideLifecycle({
      endActiveTerminalContext: vi.fn(),
      destroy,
    });

    lifecycle.remove();
    window.dispatchEvent(new Event("pagehide"));

    expect(destroy).not.toHaveBeenCalled();
  });
});
