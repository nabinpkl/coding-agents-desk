import { describe, expect, it } from "vitest";
import { initialSurface, rememberedSession } from "@/app/BrowserSurfaces";

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
  });

  it("opens the workspace IDE when the link asks for it", () => {
    // `?entry=ide` reaches the tab bar rather than the container branch in `main.tsx`: only a
    // native shell can declare the IDE as the whole page (ADR-0115, panelEntry.ts).
    expect(initialSurface("?entry=ide")).toBe("ide");
    expect(initialSurface("?entry=screen&fixture")).toBe("screen");
  });

  it("treats an entry it does not serve as no request at all", () => {
    expect(initialSurface("?entry=park")).toBe("desktop");
    expect(initialSurface("?entry=")).toBe("desktop");
  });
});

describe("rememberedSession", () => {
  it("reopens on the session the panel was last showing", () => {
    localStorage.setItem("agentdesk.panel.session", "agent");
    expect(rememberedSession()).toBe("agent");
  });

  it("treats no memory as the default session", () => {
    localStorage.removeItem("agentdesk.panel.session");
    expect(rememberedSession()).toBeUndefined();
  });

  it("refuses a stored id that could reshape the path it becomes", () => {
    localStorage.setItem("agentdesk.panel.session", "../api");
    expect(rememberedSession()).toBeUndefined();
    localStorage.setItem("agentdesk.panel.session", "a/b");
    expect(rememberedSession()).toBeUndefined();
  });
});
