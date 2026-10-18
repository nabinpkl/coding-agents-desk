// The title queue: every Bot session ends up wearing its anchor, a session that cannot take the
// rename yet is asked again when it next moves, and nothing is ever sent twice.
import { afterEach, expect, test } from "bun:test";
import type { BotSessionRef } from "@agentdesk/agent-feed-wire";
import { botRegistryHarness } from "@/bots/botRegistryHarness";
import { anchoredTitle, BotTitleQueue } from "@/bots/sessions/botTitleQueue";

const { addBot, addSessions, catalog, fixture, notifyCatalog, sessions, summary } = botRegistryHarness();

const queues: BotTitleQueue[] = [];
afterEach(() => {
  for (const queue of queues.splice(0)) queue.stop();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

function startQueue(
  store: Fixture["store"],
  renamer: (ref: BotSessionRef, title: string) => Promise<void>,
  renamable: (source: string) => boolean = () => true,
  whenReady: (ref: BotSessionRef) => Promise<boolean> = async () => true,
) {
  const lines: string[] = [];
  const paneListeners = new Set<(sessionId: string) => void>();
  const queue = new BotTitleQueue({
    store,
    catalog,
    renamer,
    renamable,
    paneStarts: (listener) => {
      paneListeners.add(listener);
      return () => paneListeners.delete(listener);
    },
    whenReady,
    log: (line) => lines.push(line),
  });
  queues.push(queue);
  queue.start();
  const paneStarted = (sessionId: string) => {
    for (const listener of paneListeners) listener(sessionId);
  };
  return { queue, lines, paneStarted };
}

/** Sets a session's title and how recently it moved, the way the catalog would after a write. */
function moved(project: string, ref: BotSessionRef, title: string, lastEventAt: number): void {
  sessions.set(`${ref.source}:${ref.sessionId}`, {
    projectPath: project,
    summary: { ...summary(ref), title, lastEventAt },
  });
  notifyCatalog();
}

test("anchoredTitle keeps a hand-typed title as the task and sheds old suffixes", () => {
  expect(anchoredTitle("Clifford", "Bot father & Note manager")).toEqual({
    title: "Clifford (Bot father & Note manager)",
  });
  expect(anchoredTitle("Aaron", "Aaron (night shift)")).toEqual({ title: "Aaron (night shift)" });
  expect(anchoredTitle("Clara", "Clara")).toEqual({ title: "Clara" });
  expect(anchoredTitle("Adam", "Windows canvas (fork 1)")).toEqual({ title: "Adam (Windows canvas)" });
  expect(anchoredTitle("Aaron", "fix (urgent) bug")).toEqual({ title: "Aaron", dropped: "fix (urgent) bug" });
  expect(anchoredTitle("Aaron", "x".repeat(239))).toEqual({ title: "Aaron", dropped: "x".repeat(239) });
});

test("a session moved to a new name keeps its task, not its old name", () => {
  expect(anchoredTitle("Acacia", "Adam (See where are we)")).toEqual({ title: "Acacia (See where are we)" });
  expect(anchoredTitle("Acacia", "Aaron 2 (Rags 2)")).toEqual({ title: "Acacia (Rags 2)" });
  expect(anchoredTitle("Acacia", "Adam")).toEqual({ title: "Acacia" });
  // Not a pool name, so still the previous era's title with its suffix shed.
  expect(anchoredTitle("Acacia", "Windows canvas (fork 1)")).toEqual({ title: "Acacia (Windows canvas)" });
});

test("spends anchors a record predates and renames every session it can", async () => {
  const { project, ref, secondRef, claudeRef, registry, store } = await fixture();
  sessions.set("pi:session-1", { projectPath: project, summary: { ...summary(ref), title: "Windows canvas" } });
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(
    registry,
    bot.botId,
    { requestId: "attach", sessionRefs: [ref, secondRef, claudeRef] },
    { kind: "user" },
  );
  // As a record written before anchors existed.
  await store.mutate((snapshot) => {
    const next = {
      ...snapshot,
      revision: snapshot.revision + 1,
      bots: snapshot.bots.map(({ sessionAnchors: _dropped, ...rest }) => rest),
    };
    return { snapshot: next, value: undefined };
  });

  const renamed: { ref: BotSessionRef; title: string }[] = [];
  const { queue } = startQueue(store, async (at, title) => {
    renamed.push({ ref: at, title });
  });
  await queue.settled();

  expect(renamed).toEqual([
    { ref, title: "Aaron (Windows canvas)" },
    { ref: secondRef, title: "Adam (codex session)" },
    { ref: claudeRef, title: "Alan (claude session)" },
  ]);
  const stored = (await store.snapshot()).bots[0]!;
  expect(stored.sessionAnchors).toEqual({
    "pi:session-1": "Aaron",
    "codex:session-2": "Adam",
    "claude:session-3": "Alan",
  });
});

test("a refused rename waits for the session to move, then is asked again", async () => {
  const { project, ref, registry, store } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  let running = false;
  const asked: string[] = [];
  const { queue, lines } = startQueue(store, async (at, title) => {
    asked.push(title);
    if (!running) throw new Error("this session is not running, and only a running session can rename itself");
    moved(project, at, title, 4);
  });
  await queue.settled();
  expect(asked).toEqual(["Aaron (pi session)"]);
  expect(lines[0]).toContain("waits for");

  // Churn that is not this session moving asks nothing.
  notifyCatalog();
  await queue.settled();
  expect(asked).toHaveLength(1);

  // Moving while still unable to take it asks again, and says so only once.
  moved(project, ref, "pi session", 2);
  await queue.settled();
  expect(asked).toHaveLength(2);
  expect(lines.filter((one) => one.includes("waits for"))).toHaveLength(1);

  // It starts again: its transcript moves, and this time the rename lands.
  running = true;
  moved(project, ref, "pi session", 3);
  await queue.settled();
  expect(asked).toEqual(["Aaron (pi session)", "Aaron (pi session)", "Aaron (pi session)"]);
  expect(sessions.get("pi:session-1")!.summary.title).toBe("Aaron (pi session)");
});

test("a sent rename is not sent twice, and a later hand rename is wrapped again", async () => {
  const { project, ref, registry, store } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  const asked: string[] = [];
  const { queue } = startQueue(store, async (_at, title) => {
    asked.push(title);
  });
  await queue.settled();
  expect(asked).toEqual(["Aaron (pi session)"]);

  // The session moves before its new title shows up: still not sent again.
  moved(project, ref, "pi session", 2);
  await queue.settled();
  expect(asked).toHaveLength(1);

  // The title lands, then somebody types `/rename` by hand.
  moved(project, ref, "Aaron (pi session)", 3);
  await queue.settled();
  moved(project, ref, "Night shift", 4);
  await queue.settled();
  expect(asked).toEqual(["Aaron (pi session)", "Aaron (Night shift)"]);
});

test("no rename for a source without a mechanism, a session two Bots hold, or one already in shape", async () => {
  const { project, ref, secondRef, claudeRef, secondProject, registry, store } = await fixture();
  sessions.set("claude:session-3", { projectPath: project, summary: { ...summary(claudeRef), title: "Alan" } });
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(
    registry,
    bot.botId,
    { requestId: "attach", sessionRefs: [ref, secondRef, claudeRef] },
    { kind: "user" },
  );
  // The pi session also joins a second Bot, so it has two anchors.
  sessions.set("pi:session-1", { projectPath: secondProject, summary: summary(ref) });
  const other = await addBot(
    registry,
    { requestId: "add-2", name: "Second", directoryPath: secondProject },
    { kind: "user" },
  );
  await addSessions(registry, other.botId, { requestId: "attach-2", sessionRefs: [ref] }, { kind: "user" });

  const asked: string[] = [];
  const { queue } = startQueue(
    store,
    async (at) => {
      asked.push(`${at.source}:${at.sessionId}`);
    },
    (source) => source !== "codex",
  );
  await queue.settled();
  expect(asked).toEqual([]);
});

test("a session reopened in a pane is renamed once it is ready, without waiting to move", async () => {
  const { project, ref, registry, store } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  let running = false;
  let ready: (value: boolean) => void = () => {};
  const asked: string[] = [];
  const { queue, paneStarted } = startQueue(
    store,
    async (_at, title) => {
      asked.push(title);
      if (!running) throw new Error("this session is not running, and only a running session can rename itself");
    },
    () => true,
    () =>
      new Promise<boolean>((resolve) => {
        ready = resolve;
      }),
  );
  await queue.settled();
  expect(asked).toHaveLength(1);

  // Its pane starts. Nothing is sent while the CLI is still loading.
  paneStarted("session-1");
  await queue.settled();
  expect(asked).toHaveLength(1);

  // Its composer is drawn: the rename goes in although the transcript has not moved.
  running = true;
  ready(true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await queue.settled();
  expect(asked).toEqual(["Aaron (pi session)", "Aaron (pi session)"]);
});

test("a pane that never came up, or one no Bot holds, asks nothing", async () => {
  const { project, ref, registry, store } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  const asked: string[] = [];
  const waited: string[] = [];
  const { queue, paneStarted } = startQueue(
    store,
    async (_at, title) => {
      asked.push(title);
      throw new Error("this session is not running, and only a running session can rename itself");
    },
    () => true,
    async (at) => {
      waited.push(at.sessionId);
      return false;
    },
  );
  await queue.settled();
  paneStarted("session-1");
  paneStarted("not-on-any-bot");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await queue.settled();
  expect(waited).toEqual(["session-1"]);
  expect(asked).toHaveLength(1);
});
