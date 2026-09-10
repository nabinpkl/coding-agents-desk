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
