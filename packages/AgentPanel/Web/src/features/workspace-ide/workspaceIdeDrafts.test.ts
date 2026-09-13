import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  draftKey,
  loadDraft,
  reconcileDraft,
  removeDraft,
  storeDraft,
  type WorkspaceDraft,
} from "@/features/workspace-ide/workspaceIdeDrafts";

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

/**
 * Make the next `quotaFailures` writes throw, then let the rest through.
 *
 * Patched on the prototype rather than on the instance: `Storage` is a proxy whose property sets
 * become stored items, so assigning `sessionStorage.setItem` stores a value called "setItem" and
 * leaves the method exactly as it was.
 */
function refuseWrites(quotaFailures: number) {
  const real = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (quotaFailures > 0) {
      quotaFailures -= 1;
      throw new DOMException("full", "QuotaExceededError");
    }
    real.call(this, key, value);
  });
}

const draft = (over: Partial<WorkspaceDraft> = {}): WorkspaceDraft => ({
  text: "typed",
  baselineRevision: "rev-1",
  updatedAt: 1,
  ...over,
});

it("keeps a draft per workspace and path, so one file's text cannot appear in another", () => {
  storeDraft("w-1", "src/a.ts", draft({ text: "one" }));
  storeDraft("w-2", "src/a.ts", draft({ text: "two" }));
  storeDraft("w-1", "src/b.ts", draft({ text: "three" }));

  expect(loadDraft("w-1", "src/a.ts")?.text).toBe("one");
  expect(loadDraft("w-2", "src/a.ts")?.text).toBe("two");
  expect(loadDraft("w-1", "src/b.ts")?.text).toBe("three");
  expect(loadDraft("w-1", "src/missing.ts")).toBeNull();
});

it("forgets a draft when it is removed, rather than leaving the previous text behind", () => {
  storeDraft("w-1", "a.ts", draft());
  removeDraft("w-1", "a.ts");
  expect(loadDraft("w-1", "a.ts")).toBeNull();
});

it("treats a half-written record as no draft, not as a draft of undefined", () => {
  // The failure this prevents is silent and destructive: a draft whose text is `undefined` renders
  // as the string "undefined" in the editor, and autosave then writes that over the file.
  //
  // The keys come from `draftKey` rather than being spelled out. Spelled out, this test passed
  // while asserting nothing: it planted a record under a key the code never reads, so `loadDraft`
  // returned null because it found nothing rather than because it refused what it found.
  sessionStorage.setItem(draftKey("w-1", "a.ts"), JSON.stringify({ updatedAt: 1 }));
  expect(loadDraft("w-1", "a.ts")).toBeNull();

  sessionStorage.setItem(draftKey("w-1", "b.ts"), "not json at all");
  expect(loadDraft("w-1", "b.ts")).toBeNull();

  // And a whole record still reads back, so the two above are refusals and not a broken key.
  sessionStorage.setItem(draftKey("w-1", "c.ts"), JSON.stringify(draft({ text: "kept" })));
  expect(loadDraft("w-1", "c.ts")?.text).toBe("kept");
});

it("says so when it could not keep the text, instead of reporting success", () => {
  refuseWrites(Number.POSITIVE_INFINITY);
  expect(storeDraft("w-1", "a.ts", draft())).toBe(false);
});

it("evicts the oldest draft to make room rather than dropping the one being written", () => {
  storeDraft("w-1", "old.ts", draft({ text: "old", updatedAt: 1 }));
  storeDraft("w-1", "newer.ts", draft({ text: "newer", updatedAt: 2 }));

  // Refuse the first write, then accept once something has been evicted.
  refuseWrites(1);
  expect(storeDraft("w-1", "wanted.ts", draft({ text: "wanted", updatedAt: 3 }))).toBe(true);

  expect(loadDraft("w-1", "wanted.ts")?.text).toBe("wanted");
  expect(loadDraft("w-1", "old.ts")).toBeNull();
  expect(loadDraft("w-1", "newer.ts")?.text).toBe("newer");
});

it("reads nothing back when there is no draft", () => {
  expect(reconcileDraft(null, "on disk", "rev-1")).toEqual({ state: "none" });
});

it("drops a draft that says what the file already says", () => {
  // Saved by this reader before the reload, or by someone else since. Either way nothing is
  // unsaved, so keeping it would offer the reader a decision that no longer exists.
  expect(reconcileDraft(draft({ text: "same" }), "same", "rev-9")).toEqual({ state: "identical" });
});

it("restores a draft as unsaved while the file has not moved under it", () => {
  expect(reconcileDraft(draft({ text: "typed", baselineRevision: "rev-1" }), "on disk", "rev-1"))
    .toEqual({ state: "unsaved", text: "typed" });
});

it("restores a draft as a conflict once the file has moved under it", () => {
  // The baseline is why the record exists. Without it a restore could only offer the text back,
  // having lost the fact that there was ever a divergence to resolve.
  expect(reconcileDraft(draft({ text: "typed", baselineRevision: "rev-1" }), "theirs", "rev-2"))
    .toEqual({ state: "conflict", text: "typed" });
});
