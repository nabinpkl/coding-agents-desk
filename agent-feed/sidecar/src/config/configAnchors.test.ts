// A machine's pool is named once; a name nobody defined refuses rather than falling back.
import { expect, test } from "bun:test";
import { ANCHOR_POOLS } from "@agentdesk/agent-feed-wire";
import { anchorPoolNamed } from "@/config/configAnchors";

test("no setting is the default pool, and a known name is that pool", () => {
  expect(anchorPoolNamed(undefined)).toBe(ANCHOR_POOLS.people!);
  expect(anchorPoolNamed(" ")).toBe(ANCHOR_POOLS.people!);
  expect(anchorPoolNamed("trees")).toBe(ANCHOR_POOLS.trees!);
});

test("an unknown pool refuses, because the default would share another machine's names", () => {
  expect(() => anchorPoolNamed("rivers")).toThrow(/not one of people, trees/);
});
