import { describe, expect, test } from "bun:test";
import { desktopNavigationEvent } from "@agentdesk/agent-feed-wire";
import fixture from "@repo/agent-feed/wire/navigation-fixture.json";
import { desktopControlInput, desktopControlLine } from "@/http/tile/tile-control/webrtcDesktopControl";
import { DisplayTargetUnavailable, resolveDisplayTarget } from "@/http/tile/tile-encoder/webrtcDisplayTarget";

describe("desktop navigation contracts", () => {
  test("shared native commands survive exact NDJSON forwarding", () => {
    for (const command of fixture.commands) {
      const input = desktopControlInput(JSON.stringify(command));
      expect(input as unknown).toEqual(command);
      expect(desktopControlLine(input!)).toBe(JSON.stringify(command) + "\n");
    }
  });
  test("rejects unsafe IDs, phases, and non-finite or oversized progress", () => {
    for (const patch of [{ phase: "other" }, { progress: 1.01 }, { velocityX: null }, { gestureId: "x" }]) {
      expect(desktopControlInput(JSON.stringify({ ...fixture.commands[3], ...patch }))).toBeNull();
    }
    expect(desktopControlInput(JSON.stringify({ ...fixture.commands[1], spaceId: 9007199254740993 }))).toBeNull();
    expect(desktopControlInput(JSON.stringify({ ...fixture.commands[3], phase: "ended", progress: 0 }))).toBeNull();
    expect(desktopControlInput(JSON.stringify({ ...fixture.commands[3], progress: true }))).toBeNull();
  });
  test("main alias and explicit monitor resolve to one capture key", async () => {
    const read = async () => ({ available: true, displays: [{ id: "A", isMain: true, captureId: 1 }] });
    expect(await resolveDisplayTarget(undefined, read)).toEqual(await resolveDisplayTarget("A", read));
    await expect(resolveDisplayTarget("B", read)).rejects.toThrow("display-unavailable");
  });
  test("each monitor has its own active Space, including fullscreen", () => {
    expect(
      desktopNavigationEvent({
        type: "desktop-state",
        revision: 1,
        captureDisplayId: "A",
        displays: [
          { id: "A", label: "Built-in", isMain: true, activeSpaceId: "1", spaces: [{ id: "1", type: 0 }] },
          {
            id: "B",
            label: "External",
            isMain: false,
            activeSpaceId: fixture.spaceId,
            spaces: [{ id: fixture.spaceId, type: 4 }],
          },
        ],
      }),
    ).not.toBeNull();
  });
  test("an unplug response names the replacement without silently capturing it", async () => {
    try {
      await resolveDisplayTarget("B", async () => ({
        available: true,
        displays: [{ id: "A", isMain: true, captureId: 7 }],
      }));
      throw new Error("missing display should reject");
    } catch (error) {
      expect(error).toBeInstanceOf(DisplayTargetUnavailable);
      expect((error as DisplayTargetUnavailable).replacementDisplayId).toBe("A");
    }
  });
  test("malformed discovery is unavailable rather than a truncated inventory", async () => {
    await expect(
      resolveDisplayTarget(undefined, async () => ({
        available: true,
        displays: [{ id: "A", isMain: true, captureId: -1 }],
      })),
    ).rejects.toThrow("navigation-unavailable");
  });
});
