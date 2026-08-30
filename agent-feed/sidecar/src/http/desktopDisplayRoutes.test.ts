import { describe, expect, test } from "bun:test";
import { createDesktopDisplayRoutes, type DesktopDisplaySource } from "./desktopDisplayRoutes.ts";

const server = undefined as never;

function request(path = "/api/desktop/display", method = "GET"): [Request, URL] {
  const url = new URL(`http://127.0.0.1${path}`);
  return [new Request(url.toString(), { method }), url];
}

function source(overrides: Partial<DesktopDisplaySource> = {}): DesktopDisplaySource {
  return {
    activeSpace: async () => ({ index: 4, id: 44, display: 2 }),
    displays: async () => [
      { index: 1, frame: { x: 0, y: 0, w: 1440, h: 900 } },
      { index: 2, frame: { x: 1440, y: 0, w: 1800, h: 1169 } },
    ],
    ...overrides,
  };
}

describe("desktop display route", () => {
  test("returns only the active display geometry", async () => {
    const route = createDesktopDisplayRoutes(source());
    const response = await route(...request(), server)!;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      display: { index: 2, frame: { x: 1440, y: 0, w: 1800, h: 1169 } },
    });
  });

  test("does not claim other paths or methods", () => {
    const route = createDesktopDisplayRoutes(source());
    expect(route(...request("/api/desktop/display", "POST"), server)).toBeUndefined();
    expect(route(...request("/api/park/state"), server)).toBeUndefined();
  });

  test("fails visibly when no display is available", async () => {
    const route = createDesktopDisplayRoutes(source({ displays: async () => [] }));
    const response = await route(...request(), server)!;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "desktop-display-unavailable",
      message: "yabai reported no displays",
    });
  });
});
