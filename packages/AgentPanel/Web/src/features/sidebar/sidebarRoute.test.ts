import { describe, expect, it } from "vitest";
import { searchWithSidebarMode, sidebarModeFromSearch } from "./sidebarRoute";

describe("sidebar route", () => {
  it("reads a view this panel has", () => {
    expect(sidebarModeFromSearch("?entry=feed&view=canvas")).toBe("canvas");
    expect(sidebarModeFromSearch("?view=bots")).toBe("bots");
  });

  it("answers nothing for an address that names no view it has", () => {
    // A hand-typed or stale value must fall through to whatever the panel would have opened on,
    // not select a view that does not exist and leave the tablist with nothing highlighted.
    expect(sidebarModeFromSearch("?entry=feed")).toBeNull();
    expect(sidebarModeFromSearch("?view=desktop")).toBeNull();
    expect(sidebarModeFromSearch("")).toBeNull();
  });

  it("names the view without disturbing the rest of the address", () => {
    // `entry` is the surface and belongs to another owner; writing the view must not drop it.
    expect(searchWithSidebarMode("?entry=feed", "canvas")).toBe("?entry=feed&view=canvas");
    expect(searchWithSidebarMode("?entry=feed&view=bots", "sessions"))
      .toBe("?entry=feed&view=sessions");
    expect(searchWithSidebarMode("", "bots")).toBe("?view=bots");
  });
});
