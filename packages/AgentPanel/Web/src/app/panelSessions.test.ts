import { describe, expect, it } from "vitest";
import { parseSessionIndex, sessionApiPrefix } from "@/app/panelSessions";

describe("sessionApiPrefix", () => {
  it("leaves the default session where every existing caller expects it", () => {
    expect(sessionApiPrefix()).toBe("/api");
    expect(sessionApiPrefix(undefined)).toBe("/api");
  });

  it("gives every other session its own prefix", () => {
    expect(sessionApiPrefix("agent")).toBe("/session/agent/api");
  });
});

describe("parseSessionIndex", () => {
  it("reads the default session and the named ones", () => {
    expect(parseSessionIndex([{ label: "dev" }, { id: "agent", label: "Agent" }])).toEqual([
      { label: "dev" },
      { id: "agent", label: "Agent" },
    ]);
  });

  it("treats an origin that serves no index as one session, which is what it is", () => {
    expect(parseSessionIndex(undefined)).toEqual([]);
    expect(parseSessionIndex({ sessions: [] })).toEqual([]);
    expect(parseSessionIndex("nope")).toEqual([]);
  });

  it("drops what it could not render or address", () => {
    expect(parseSessionIndex([{ label: "" }, { id: "a/b", label: "Bad" }, { label: "ok" }])).toEqual([{ label: "ok" }]);
  });

  it("keeps the first of a repeated id, so a duplicate cannot shadow a session", () => {
    expect(
      parseSessionIndex([
        { id: "a", label: "First" },
        { id: "a", label: "Second" },
      ]),
    ).toEqual([{ id: "a", label: "First" }]);
  });
});
