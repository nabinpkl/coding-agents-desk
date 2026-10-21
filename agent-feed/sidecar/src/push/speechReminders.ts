// The reminders waiting sessions are owed (`turnFinishedNotifier.ts`), kept on disk so a sidecar
// restart does not drop them. A restart is frequent: every save under `bun --watch`, and every time
// the supervisor replaces the tree. A reminder lives in memory as a timer, so without this file a
// wait that began before a restart was never said again.
//
// One record per session: the status it is about (`at`) and when it is due. Set when the reminder
// is, gone once it fires. The notifier decides at firing time whether the wait still stands, so a
// record left behind by a wait that ended is harmless: it fires, finds nothing to say, and goes.
//
// Only the sidecar holding the sender lease sets reminders, but both the stable and dev sidecars
// read this file, so a write takes the same lock and rename as `bots.json`. Writes from this
// process also go one at a time, in the order they were asked for: a reminder replaced straight
// after it was set must not land before the one it replaces.

import { readFile } from "node:fs/promises";
import { acquireFileLock, writeJsonAtomically } from "@/config/lockedJsonFile";

export type StoredReminder = {
  /** The session, as `<source>:<sessionId>`. */
  key: string;
  /** When the status it is about was written, which is how the notifier tells it is the same wait. */
  at: number;
  /** When it is said, in epoch milliseconds. */
  due: number;
};

export type ReminderStore = {
  load(): Promise<StoredReminder[]>;
  /** Stores `reminder`, replacing any earlier one for its session. */
  save(reminder: StoredReminder): Promise<void>;
  /** Removes the session's reminder, if it is still the one about `at`. */
  remove(key: string, at: number): Promise<void>;
};

function isReminder(value: unknown): value is StoredReminder {
  const { key, at, due } = (value ?? {}) as Partial<Record<keyof StoredReminder, unknown>>;
  return typeof key === "string" && key.length > 0 && Number.isFinite(at) && Number.isFinite(due);
}

async function readReminders(path: string): Promise<StoredReminder[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const reminders = (JSON.parse(text) as { reminders?: unknown } | null)?.reminders;
  if (!Array.isArray(reminders)) throw new Error(`speech reminders at ${path} are not { reminders: [...] }`);
  return reminders.filter(isReminder);
}

export function fileReminderStore(path: string): ReminderStore {
  let queue: Promise<unknown> = Promise.resolve();

  /** Runs `change` on the stored list under the lock, after every write this process asked for first. */
  const update = (change: (reminders: StoredReminder[]) => StoredReminder[]): Promise<void> => {
    const write = queue.then(async () => {
      const release = await acquireFileLock(path);
      try {
        // A file that will not parse holds nothing worth keeping: it is only ever this list.
        const stored = await readReminders(path).catch((error: unknown) => {
          console.error(`[speech] speech reminders at ${path} unreadable, starting them over`, error);
          return [];
        });
        await writeJsonAtomically(path, { reminders: change(stored) });
      } finally {
        await release();
      }
    });
    queue = write.catch(() => undefined);
    return write;
  };

  return {
    load: () => readReminders(path),
    save: (reminder) => update((stored) => [...stored.filter((item) => item.key !== reminder.key), reminder]),
    remove: (key, at) => update((stored) => stored.filter((item) => item.key !== key || item.at !== at)),
  };
}
