import { describe, expect, it } from "vitest";
import { panelEntry } from "./panelEntry";

describe("panelEntry", () => {
  it("selects the desktop viewer only when the native shell names it", () => {
    expect(panelEntry("desktop")).toBe("desktop");
  });

  it("keeps every absent or unknown value on the agent feed", () => {
    expect(panelEntry(undefined)).toBe("feed");
    expect(panelEntry("park")).toBe("feed");
  });
});
