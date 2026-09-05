import { describe, expect, it } from "vitest";
import { initialSurface } from "./BrowserSurfaces";

describe("initialSurface", () => {
  it("opens a browser tab on the desktop viewer, the surface it could not otherwise reach", () => {
    expect(initialSurface("")).toBe("desktop");
    expect(initialSurface("?entry=desktop")).toBe("desktop");
    expect(initialSurface("?fixture")).toBe("desktop");
  });

  it("opens on the feed when the URL asks for it", () => {
    expect(initialSurface("?entry=feed")).toBe("feed");
    expect(initialSurface("?entry=feed&fixture")).toBe("feed");
  });

  it("opens on the screen when asked, which is the surface a locked-out Mac needs", () => {
    expect(initialSurface("?entry=screen")).toBe("screen");
    expect(initialSurface("?entry=screen&fixture")).toBe("screen");
  });

  it("treats an entry it does not serve as no request at all", () => {
    expect(initialSurface("?entry=park")).toBe("desktop");
    expect(initialSurface("?entry=")).toBe("desktop");
  });
});
