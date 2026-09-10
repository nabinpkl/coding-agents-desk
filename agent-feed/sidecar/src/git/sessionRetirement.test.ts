// The reusable half on its own, with no Bot in front of it.
//
// These exist because the Bot edge also checks the disposal pairs, so a core that had stopped
// checking them would still pass every test in `botRegistryRetire.test.ts`. The point of this file
// is the caller that does NOT go through that edge -- a retire route on a session, which is what
// this module was separated out for.

import { expect, test } from "bun:test";
import { disposalRefusal, planSessionRetirement } from "@/git/sessionRetirement";
import { WorktreeError } from "@/git/worktree";

test("names the disposal pairs that cannot mean what they say", () => {
  expect(disposalRefusal({ worktree: "keep", branch: "delete", remote: "keep" }))
    .toContain('branch: "delete" requires worktree: "remove"');
  expect(disposalRefusal({ worktree: "remove", branch: "keep", remote: "delete" }))
    .toContain('remote: "delete" requires branch: "delete"');
  expect(disposalRefusal({ worktree: "remove", branch: "delete", remote: "delete" })).toBeNull();
  expect(disposalRefusal({ worktree: "keep", branch: "keep", remote: "keep" })).toBeNull();
});

test("the core refuses those pairs itself, rather than trusting a caller to have checked", async () => {
  // Without this the pair plans cleanly, disposes nothing, and reports an empty `failed`: the
  // caller asked for the remote to go, nothing went, and nothing said so.
  await expect(planSessionRetirement({
    checkout: "/nowhere",
    projectPath: "/nowhere/side",
    disposals: { worktree: "remove", branch: "keep", remote: "delete" },
  })).rejects.toBeInstanceOf(WorktreeError);

  await expect(planSessionRetirement({
    checkout: "/nowhere",
    disposals: { worktree: "keep", branch: "delete", remote: "keep" },
  })).rejects.toBeInstanceOf(WorktreeError);
});

test("keeping everything needs nothing from the disk, so a path it cannot read is still fine", async () => {
  // The reason a session the catalog has forgotten can still be ended and forgotten.
  expect(await planSessionRetirement({
    checkout: "/nowhere",
    disposals: { worktree: "keep", branch: "keep", remote: "keep" },
  })).toEqual({ checkout: "/nowhere" });
});
