import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileReminderStore } from "@/push/speechReminders";

const directories: string[] = [];

async function storePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "speech-reminders-"));
  directories.push(directory);
  return join(directory, "speech-reminders.json");
}

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("speech reminder store", () => {
  test("holds nothing before anything is saved", async () => {
    expect(await fileReminderStore(await storePath()).load()).toEqual([]);
  });

  test("keeps one reminder per session, and removes it only for the wait it was about", async () => {
    const path = await storePath();
    const store = fileReminderStore(path);
    await store.save({ key: "claude:s1", at: 1, due: 100 });
    await store.save({ key: "claude:s2", at: 5, due: 200 });
    await store.save({ key: "claude:s1", at: 2, due: 300 });
    // An older wait's removal leaves the newer one standing.
    await store.remove("claude:s1", 1);
    expect(await fileReminderStore(path).load()).toEqual([
      { key: "claude:s2", at: 5, due: 200 },
      { key: "claude:s1", at: 2, due: 300 },
    ]);
    await store.remove("claude:s1", 2);
    expect(await store.load()).toEqual([{ key: "claude:s2", at: 5, due: 200 }]);
  });

  test("writes asked for together land in the order they were asked for", async () => {
    const store = fileReminderStore(await storePath());
    await Promise.all([
      store.save({ key: "claude:s1", at: 1, due: 100 }),
      store.save({ key: "claude:s1", at: 2, due: 200 }),
      store.remove("claude:s1", 1),
    ]);
    expect(await store.load()).toEqual([{ key: "claude:s1", at: 2, due: 200 }]);
  });

  test("a file that will not parse is refused on load and started over by the next write", async () => {
    const path = await storePath();
    await writeFile(path, "{ not json");
    const store = fileReminderStore(path);
    await expect(store.load()).rejects.toThrow();
    await store.save({ key: "claude:s1", at: 1, due: 100 });
    expect(await store.load()).toEqual([{ key: "claude:s1", at: 1, due: 100 }]);
  });
});
