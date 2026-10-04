// The one cursor model a viewer has: what it sends, what it draws, and when it admits a guess.

import { describe, expect, it } from "vitest";
import type { DesktopPointerInput } from "@agentdesk/agent-feed-wire";
import { RemoteCursor, type RemoteCursorChange } from "@/features/desktop-viewer/pointer-input/remoteCursor";

function cursorKit(accept = () => true) {
  const sent: DesktopPointerInput[] = [];
  const changes: RemoteCursorChange[] = [];
  const timers = new Map<number, { at: number; callback: () => void }>();
  let clock = 0;
  let nextTimer = 1;
  const cursor = new RemoteCursor({
    send: (input) => {
      if (!accept()) return false;
      sent.push(input);
      return true;
    },
    now: () => clock,
    setTimer: (callback, delayMs) => {
      const handle = nextTimer++;
      timers.set(handle, { at: clock + delayMs, callback });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle);
    },
  });
  cursor.subscribe((change) => changes.push(change));
  return {
    cursor,
    sent,
    changes,
    advance: (ms: number) => {
      clock += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at > clock) continue;
        timers.delete(handle);
        timer.callback();
      }
    },
  };
}

describe("RemoteCursor", () => {
  it("numbers each move, draws it at once, and clamps it into the display", () => {
    const { cursor, sent } = cursorKit();
    cursor.reset({ width: 200, height: 100 }, { x: 190, y: 50 });
    cursor.move(30, -80);
    expect(sent).toEqual([{ type: "pointer-move", revision: 1, dx: 30, dy: -80 }]);
    expect(cursor.position).toEqual({ x: 199, y: 0 });
  });

  it("turns an unconfirmed move into a ghost after 250ms, and back when the Mac confirms it", () => {
    const { cursor, advance } = cursorKit();
    cursor.reset({ width: 200, height: 100 });
    cursor.move(5, 0);
    expect(cursor.confidence).toBe("awaiting-host");
    advance(249);
    expect(cursor.confidence).toBe("awaiting-host");
    advance(1);
    expect(cursor.confidence).toBe("ghost");
    cursor.applyEvent({ type: "cursor-applied", revision: 1, x: 105, y: 50 });
    expect(cursor.confidence).toBe("confirmed");
    expect(cursor.position).toEqual({ x: 105, y: 50 });
  });

  it("does not draw a move the transport refused, and says the drawing cannot be trusted", () => {
    const { cursor, changes } = cursorKit(() => false);
    cursor.reset({ width: 200, height: 100 }, { x: 10, y: 10 });
    expect(cursor.move(5, 0)).toBe(false);
    expect(cursor.position).toEqual({ x: 10, y: 10 });
    expect(cursor.confidence).toBe("ghost");
    expect(changes.at(-1)).toBe("confidence");
  });

  it("warps once per pixel, numbered in the same sequence as moves", () => {
    const { cursor, sent } = cursorKit();
    cursor.reset({ width: 200, height: 100 }, { x: 10, y: 10 });
    cursor.move(1, 0);
    cursor.warp({ x: 50.2, y: 20 });
    cursor.warp({ x: 50.4, y: 20 });
    expect(sent).toEqual([
      { type: "pointer-move", revision: 1, dx: 1, dy: 0 },
      { type: "pointer-warp", revision: 2, x: 50.2, y: 20 },
    ]);
  });

  it("forgets every guess when it is reset onto a new display", () => {
    const { cursor, sent } = cursorKit();
    cursor.reset({ width: 200, height: 100 });
    cursor.move(1, 0);
    cursor.reset({ width: 400, height: 300 }, { x: 5, y: 5 });
    cursor.move(1, 0);
    expect(sent.at(-1)).toEqual({ type: "pointer-move", revision: 1, dx: 1, dy: 0 });
    expect(cursor.confidence).toBe("awaiting-host");
  });
});
