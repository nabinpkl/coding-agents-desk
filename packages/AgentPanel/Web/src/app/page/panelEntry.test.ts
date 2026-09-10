import { describe, expect, it } from "vitest";
import { panelEntry } from "@/app/page/panelEntry";

describe("panelEntry", () => {
  it("selects the desktop viewer when the native shell names it", () => {
    expect(panelEntry("desktop", "")).toBe("desktop");
  });

  it("keeps every absent or unknown value on the agent feed", () => {
    expect(panelEntry(undefined, "")).toBe("feed");
    expect(panelEntry("park", "")).toBe("feed");
  });

  it("lets a plain browser ask for the viewer, since it has no injection hook", () => {
    expect(panelEntry(undefined, "?entry=desktop")).toBe("desktop");
    expect(panelEntry(undefined, "?entry=desktop&foo=1")).toBe("desktop");
  });

  it("ignores an entry it does not serve", () => {
    expect(panelEntry(undefined, "?entry=park")).toBe("feed");
    expect(panelEntry(undefined, "?entry=")).toBe("feed");
  });

  it("keeps the shell's choice above the URL's, so a link cannot move a native surface", () => {
    expect(panelEntry("feed", "?entry=desktop")).toBe("feed");
  });
});

describe("the workspace IDE entry", () => {
  it("is named by a container, the way the iOS shell names the desktop", () => {
    expect(panelEntry("ide", "")).toBe("ide");
  });

  it("is NOT reachable from the query, which belongs to the tab bar", () => {
    // `?entry=ide` falls through to `BrowserSurfaces`, so a browser tab gets the IDE beside the
    // other surfaces while a container that declares it gets the whole page (ADR-0115).
    expect(panelEntry(undefined, "?entry=ide")).toBe("feed");
  });
});
