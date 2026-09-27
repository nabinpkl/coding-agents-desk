import { expect, test } from "bun:test";
import { OpencodeImageStore } from "@/agents/opencode/opencodeImageStore";

function payload(eventId: string, ordinal: number, data = "aGk=") {
  return { eventId, ordinal, mediaType: "image/png", data };
}

test("a stored picture reads back by session, event and ordinal", () => {
  const store = new OpencodeImageStore();
  store.store("s1", [payload("opencode:msg-a", 0), payload("opencode:msg-a", 1)]);
  expect(store.lookup("s1", "opencode:msg-a", 0)).toEqual({ mediaType: "image/png", data: "aGk=" });
  expect(store.lookup("s1", "opencode:msg-a", 1)).not.toBeNull();
  expect(store.lookup("s1", "opencode:msg-a", 2)).toBeNull();
  expect(store.lookup("s2", "opencode:msg-a", 0)).toBeNull();
});

test("a re-sync stores the same bytes without growing", () => {
  const store = new OpencodeImageStore(100);
  const batch = [payload("opencode:msg-a", 0, "aGk=".repeat(10))];
  store.store("s1", batch);
  store.store("s1", batch);
  // Still there after the second store, so nothing was evicted by double counting.
  expect(store.lookup("s1", "opencode:msg-a", 0)).not.toBeNull();
});

test("past the cap the oldest pictures go first", () => {
  // One picture decodes to ~54 bytes: one fits in 100, two do not.
  const store = new OpencodeImageStore(100);
  store.store("s1", [payload("opencode:msg-a", 0, "aGk=".repeat(10))]);
  store.store("s1", [payload("opencode:msg-b", 0, "aGk=".repeat(10))]);
  expect(store.lookup("s1", "opencode:msg-a", 0)).toBeNull();
  expect(store.lookup("s1", "opencode:msg-b", 0)).not.toBeNull();
});

test("a reaped session takes its pictures with it", () => {
  const store = new OpencodeImageStore();
  store.store("s1", [payload("opencode:msg-a", 0)]);
  store.store("s2", [payload("opencode:msg-b", 0)]);
  store.dropSession("s1");
  expect(store.lookup("s1", "opencode:msg-a", 0)).toBeNull();
  expect(store.lookup("s2", "opencode:msg-b", 0)).not.toBeNull();
  store.clear();
  expect(store.lookup("s2", "opencode:msg-b", 0)).toBeNull();
});
