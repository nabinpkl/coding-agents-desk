// Adding sessions to a Bot that already has some: which directories count as the Bot's,
// which session gets a label, and what forking one of its own sessions carries over.

import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BotConflictError, BotInvalidError, BotNotFoundError } from "@/bots/botRegistry";
import { botRegistryHarness } from "@/bots/botRegistryHarness";

const { addBot, addSessions, checkoutWithWorktree, fixture, projects, recordingLauncher, rewound, sessions, summary } =
  botRegistryHarness();

test("attaches a session working in a git worktree of the Bot's directory", async () => {
  // A worktree is the same project by every meaning a reader has, and refusing it made isolation
  // cost a Bot its view of the work being done for it.
  const { registry } = await fixture();
  const { checkout, worktree } = await checkoutWithWorktree();
  projects.add(checkout);
  const ref = { source: "claude" as const, sessionId: "in-worktree" };
  sessions.set("claude:in-worktree", { projectPath: worktree, summary: summary(ref) });

  const bot = await addBot(registry, { requestId: "r1", name: "Repo bot", directoryPath: checkout }, { kind: "user" });
  const attached = await addSessions(registry, bot.botId, { requestId: "r2", sessionRefs: [ref] }, { kind: "user" });

  expect(attached.sessions.map((session) => session.sessionId)).toEqual(["in-worktree"]);
  expect(attached.missingSessionRefs).toEqual([]);
  // And the row says which branch, because otherwise it is indistinguishable from a session in the
  // checkout itself while editing entirely different files.
  expect(attached.sessions[0]!.worktree).toEqual({ path: worktree, branch: "side" });
});

test("still refuses a session from a directory that is not the Bot's and not a worktree of it", async () => {
  const { registry, secondProject, secondRef } = await fixture();
  const { checkout } = await checkoutWithWorktree();
  projects.add(checkout);
  sessions.set(`codex:${secondRef.sessionId}`, {
    projectPath: secondProject,
    summary: summary(secondRef),
  });

  const bot = await addBot(registry, { requestId: "r1", name: "Repo bot", directoryPath: checkout }, { kind: "user" });

  await expect(
    addSessions(registry, bot.botId, { requestId: "r2", sessionRefs: [secondRef] }, { kind: "user" }),
  ).rejects.toThrow(BotConflictError);
});

test("attaches a session whose agent is elsewhere right now, because it has worked here", async () => {
  // A project renamed under a running session: the catalog files it wherever its agent last ran a
  // command, so attaching it used to depend on which second somebody asked. Its transcript
  // remembers the Bot's directory, and that is what attaching now asks.
  const { registry, project, secondProject } = await fixture();
  const ref = { source: "claude" as const, sessionId: "wandered" };
  const transcriptPath = join(dirname(project), "wandered.jsonl");
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({ type: "user", cwd: join(dirname(project), "import-graph") }),
      JSON.stringify({ type: "user", cwd: project }),
      JSON.stringify({ type: "user", cwd: secondProject }),
    ].join("\n") + "\n",
  );
  sessions.set("claude:wandered", { projectPath: secondProject, summary: summary(ref), transcriptPath });

  const bot = await addBot(registry, { requestId: "r1", name: "RepoShape", directoryPath: project }, { kind: "user" });
  const attached = await addSessions(registry, bot.botId, { requestId: "r2", sessionRefs: [ref] }, { kind: "user" });

  expect(attached.sessions.map((session) => session.sessionId)).toEqual(["wandered"]);
  expect(attached.missingSessionRefs).toEqual([]);
});

test("keeps showing an attached session wherever the catalog files it next, with no foreign branch", async () => {
  // Where the catalog files a session moves with its agent when its project was renamed; the Bot's
  // reference does not. Standing in another repository's worktree must not put that repository's
  // branch on this Bot's card either.
  const { registry, project, claudeRef } = await fixture();
  const { worktree } = await checkoutWithWorktree();
  const bot = await addBot(registry, { requestId: "r1", name: "Plain bot", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "r2", sessionRefs: [claudeRef] }, { kind: "user" });

  sessions.set(`claude:${claudeRef.sessionId}`, { projectPath: worktree, summary: summary(claudeRef) });
  const view = (await registry.snapshot()).bots.find((one) => one.botId === bot.botId)!;

  expect(view.sessions.map((session) => session.sessionId)).toEqual([claudeRef.sessionId]);
  expect(view.missingSessionRefs).toEqual([]);
  expect(view.sessions[0]!.worktree).toBeUndefined();
});

test("leaves a session in the Bot's own directory unlabelled, so the label means something", async () => {
  // A field present and empty on every ordinary row is one every reader learns to ignore.
  const { registry, project, ref } = await fixture();

  const bot = await addBot(registry, { requestId: "r1", name: "Plain bot", directoryPath: project }, { kind: "user" });
  const attached = await addSessions(registry, bot.botId, { requestId: "r2", sessionRefs: [ref] }, { kind: "user" });

  expect(attached.sessions[0]!.worktree).toBeUndefined();
});

test("starts a session on a Bot that already has some, and attaches it", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);

  const bot = await addBot(
    registry,
    {
      requestId: "add",
      name: "AD bot",
      directoryPath: project,
    },
    { kind: "user" },
  );
  const added = await registry.addSessions(
    bot.botId,
    { requestId: "start", launch: { title: "composer fix", prompt: "Read the brief." } },
    { kind: "user" },
  );

  // The first free anchor, with the request bracketed after it. The reservation is spent
  // before the launch, so the stored anchor and the `-n` title always agree.
  expect(launched).toEqual([
    {
      kind: "start",
      cwd: project,
      sessionId: "started-1",
      title: "Aaron (composer fix)",
      prompt: "Read the brief.",
    },
  ]);
  // The pane comes back with it: the caller has nowhere else to read it from, and rebuilding the
  // name at the call site would put the sidecar's rule in two places.
  expect(added.started).toEqual({
    sessionId: "started-1",
    title: "Aaron (composer fix)",
    projectPath: project,
    tmuxSession: "agentdesk-started-1",
  });
  expect(added.bot.missingSessionRefs).toEqual([{ source: "claude", sessionId: "started-1" }]);
  expect(added.bot.sessionSlots).toEqual({ "claude:started-1": 0 });
  expect(added.bot.sessionAnchors).toEqual({ "claude:started-1": "Aaron" });
  expect(added.bot.nextSessionSlot).toBe(1);
});

test("forks one of the Bot's own sessions, and puts the brief behind the handoff note", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, claudeRef, registry } = await fixture(launcher);

  const bot = await addBot(
    registry,
    {
      requestId: "add",
      name: "AD bot",
      directoryPath: project,
    },
    { kind: "user" },
  );
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [claudeRef] }, { kind: "user" });
  const added = await registry.addSessions(
    bot.botId,
    {
      requestId: "fork",
      launch: { title: "Bot background color", from: claudeRef, prompt: "Give each card a colour." },
    },
    { kind: "user" },
  );

  expect(launched).toEqual([
    {
      kind: "fork",
      cwd: project,
      sessionId: claudeRef.sessionId,
      forkId: "started-1",
      // The attach spent Aaron, so the fork takes Adam and the request brackets after it.
      title: "Adam (Bot background color)",
      // The launcher composes the handoff note in front of this; what the registry passes is the
      // reader's own words, unchanged.
      brief: "Give each card a colour.",
    },
  ]);
  expect(added.started?.tmuxSession).toBe("agentdesk-fork-started-1");
  expect(added.started?.title).toBe("Adam (Bot background color)");
  expect(added.bot.sessionSlots?.["claude:started-1"]).toBe(1);
  expect(added.bot.sessionAnchors?.["claude:started-1"]).toBe("Adam");
});

test("stands a fork right after its source rather than at the end of the Bot's row", async () => {
  const { launcher } = recordingLauncher();
  const { project, ref, claudeRef, registry } = await fixture(launcher);
  const bot = await addBot(registry, { requestId: "add", name: "AD bot", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [claudeRef, ref] }, { kind: "user" });

  const added = await registry.addSessions(
    bot.botId,
    { requestId: "fork", launch: { title: "Beside", from: claudeRef } },
    { kind: "user" },
  );

  expect(added.bot.sessionRefs.map((each) => each.sessionId)).toEqual([
    claudeRef.sessionId,
    "started-1",
    ref.sessionId,
  ]);
});

test("stands attached sessions after the one named, and at the end when the Bot does not hold it", async () => {
  const { project, ref, secondRef, claudeRef, registry } = await fixture();
  const bot = await addBot(registry, { requestId: "add", name: "AD bot", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [ref] }, { kind: "user" });

  const atEnd = await registry.addSessions(
    bot.botId,
    { requestId: "after-absent", sessionRefs: [claudeRef], after: secondRef },
    { kind: "user" },
  );
  expect(atEnd.bot.sessionRefs.map((each) => each.sessionId)).toEqual([ref.sessionId, claudeRef.sessionId]);

  const beside = await registry.addSessions(
    bot.botId,
    { requestId: "after-held", sessionRefs: [secondRef], after: ref },
    { kind: "user" },
  );
  expect(beside.bot.sessionRefs.map((each) => each.sessionId)).toEqual([
    ref.sessionId,
    secondRef.sessionId,
    claudeRef.sessionId,
  ]);
});

test("forks one of the Bot's own sessions from a message, and holds the brief for after the rewind", async () => {
  // The same rewind the session endpoint does, on the endpoint that attaches: a reader forking from
  // a message on a card wants the fork on that card's Bot.
  const { launched, launcher } = recordingLauncher();
  const { project, claudeRef, registry } = await fixture(launcher);
  const transcriptPath = join(project, `${claudeRef.sessionId}.jsonl`);
  const said = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
  await writeFile(transcriptPath, `${[said("ALPHA one"), said("BRAVO two")].join("\n")}\n`);
  sessions.set(`claude:${claudeRef.sessionId}`, { ...sessions.get(`claude:${claudeRef.sessionId}`)!, transcriptPath });

  const bot = await addBot(registry, { requestId: "add", name: "AD bot", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [claudeRef] }, { kind: "user" });
  const added = await registry.addSessions(
    bot.botId,
    {
      requestId: "fork",
      launch: {
        title: "From ALPHA",
        from: { ...claudeRef, eventId: `claude:${claudeRef.sessionId}:at:0` },
        prompt: "the sibling task",
      },
    },
    { kind: "user" },
  );

  expect(launched).toMatchObject([{ kind: "fork", forkId: "started-1", brief: undefined }]);
  expect(rewound).toEqual([
    {
      sessionId: "started-1",
      anchor: { fromEnd: 2, text: "ALPHA one" },
      prompt: "the sibling task",
    },
  ]);
  expect(added.started?.rewindFailed).toBeUndefined();
  expect(added.bot.sessionAnchors?.["claude:started-1"]).toBe("Adam");
});

test("numbers a fork for the place beside its source, skipping a slot that would paint like it", async () => {
  // The panel takes a card's hue from its slot round eight. Alan held 1 and his fork, standing
  // beside him, took 33: the two cards were one colour. The slot is reserved before the launch, so
  // it is there, not at the attach, that the fork's place has to be known.
  const { launcher } = recordingLauncher();
  const { project, claudeRef, ref, registry, store } = await fixture(launcher);
  const transcriptPath = join(project, `${claudeRef.sessionId}.jsonl`);
  await writeFile(transcriptPath, `${JSON.stringify({ type: "user", message: { role: "user", content: "x" } })}\n`);
  sessions.set(`claude:${claudeRef.sessionId}`, { ...sessions.get(`claude:${claudeRef.sessionId}`)!, transcriptPath });

  const bot = await addBot(registry, { requestId: "add", name: "AD bot", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [claudeRef, ref] }, { kind: "user" });
  // A Bot with history: eight sessions spent since the source took slot 0 and its neighbour 1.
  await store.mutate((snapshot) => ({
    snapshot: { ...snapshot, bots: snapshot.bots.map((one) => ({ ...one, nextSessionSlot: 8 })) },
    value: undefined,
  }));
  const added = await registry.addSessions(
    bot.botId,
    {
      requestId: "fork",
      launch: { title: "Fork", from: { ...claudeRef, eventId: `claude:${claudeRef.sessionId}:at:0` } },
    },
    { kind: "user" },
  );

  expect(added.bot.sessionRefs.map((each) => each.sessionId)).toEqual([
    claudeRef.sessionId,
    "started-1",
    ref.sessionId,
  ]);
  // 8 paints like the source's 0 and 9 like its old neighbour's 1. Numbered at the end of the row
  // instead, beside 1 alone, it would have taken 8: the source's colour, right beside it.
  expect(added.bot.sessionSlots?.["claude:started-1"]).toBe(10);
  expect(added.bot.nextSessionSlot).toBe(11);
});

test("refuses a fork from a row that is not one of the source's messages, before starting anything", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, claudeRef, registry } = await fixture(launcher);
  const transcriptPath = join(project, `${claudeRef.sessionId}.jsonl`);
  await writeFile(transcriptPath, `${JSON.stringify({ type: "user", message: { role: "user", content: "x" } })}\n`);
  sessions.set(`claude:${claudeRef.sessionId}`, { ...sessions.get(`claude:${claudeRef.sessionId}`)!, transcriptPath });
  const bot = await addBot(registry, { requestId: "add", name: "AD bot", directoryPath: project }, { kind: "user" });
  await addSessions(registry, bot.botId, { requestId: "attach", sessionRefs: [claudeRef] }, { kind: "user" });

  await expect(
    registry.addSessions(
      bot.botId,
      { requestId: "fork", launch: { title: "No", from: { ...claudeRef, eventId: "claude:someone-else:at:0" } } },
      { kind: "user" },
    ),
  ).rejects.toThrow(BotInvalidError);
  expect(launched).toEqual([]);
  expect(rewound).toEqual([]);
});

test("refuses to fork a session the Bot does not hold", async () => {
  // A Bot is what says which sessions belong to a directory, so "fork that one" is only meaningful
  // about a session it holds. Without this a Bot could branch a stranger's transcript into itself.
  const { project, claudeRef, registry } = await fixture();

  const bot = await addBot(
    registry,
    {
      requestId: "add",
      name: "AD bot",
      directoryPath: project,
    },
    { kind: "user" },
  );

  await expect(
    registry.addSessions(
      bot.botId,
      { requestId: "fork", launch: { title: "Nope", from: claudeRef } },
      { kind: "user" },
    ),
  ).rejects.toThrow(BotNotFoundError);
});

test("an omitted title starts unnamed under the next free anchor, for Claude to title", async () => {
  // The anchor is spent from the slot counter, not counted from titles, so two launches in one
  // moment cannot preview the same name and a deleted session's number is never reused. It is not
  // passed as the name: Claude titles only a session given none, and the title queue then wears
  // that title under the anchor. The anchor names the pane and the card until it does.
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);
  const bot = await addBot(
    registry,
    {
      requestId: "add",
      name: "AD bot",
      directoryPath: project,
    },
    { kind: "user" },
  );

  const added = await registry.addSessions(bot.botId, { requestId: "start", launch: {} }, { kind: "user" });

  expect(launched).toEqual([
    {
      kind: "start",
      cwd: project,
      sessionId: "started-1",
      title: "Aaron",
      unnamed: true,
      prompt: undefined,
    },
  ]);
  expect(added.started?.title).toBe("Aaron");
  expect(added.bot.sessionSlots).toEqual({ "claude:started-1": 0 });
  expect(added.bot.sessionAnchors).toEqual({ "claude:started-1": "Aaron" });
});

test("a task carrying its own brackets is refused before anything is spent", async () => {
  const { launched, launcher } = recordingLauncher();
  const { project, registry } = await fixture(launcher);
  const bot = await addBot(
    registry,
    {
      requestId: "add",
      name: "AD bot",
      directoryPath: project,
    },
    { kind: "user" },
  );

  await expect(
    registry.addSessions(bot.botId, { requestId: "start", launch: { title: "fix (urgent) bug" } }, { kind: "user" }),
  ).rejects.toThrow(/parentheses/);
  expect(launched).toEqual([]);
});

test("refuses a command that neither attaches nor starts anything", async () => {
  const { project, registry } = await fixture();
  const bot = await addBot(
    registry,
    {
      requestId: "add",
      name: "AD bot",
      directoryPath: project,
    },
    { kind: "user" },
  );

  await expect(registry.addSessions(bot.botId, { requestId: "empty" }, { kind: "user" })).rejects.toThrow(
    /sessionRefs or launch is required/,
  );
});

test("creates a Bot whose first session is a fork of one already in its directory", async () => {
  // The same launch shape at both endpoints. A directory can already hold sessions when its Bot is
  // created, and branching one of those into the new Bot's first session is the same act as
  // branching one later.
  const { launched, launcher } = recordingLauncher();
  const { project, claudeRef, registry } = await fixture(launcher);

  const first = await addBot(
    registry,
    {
      requestId: "add-first",
      name: "First",
      directoryPath: project,
    },
    { kind: "user" },
  );
  await addSessions(registry, first.botId, { requestId: "attach", sessionRefs: [claudeRef] }, { kind: "user" });

  // A second Bot cannot take the same directory, so the fork source is checked against the Bot
  // being created rather than against any Bot -- and this one holds nothing yet.
  await expect(
    registry.add(
      {
        requestId: "add-second",
        name: "Second",
        directoryPath: project,
        launch: { title: "Branch", from: claudeRef },
      },
      { kind: "user" },
    ),
  ).rejects.toThrow(BotConflictError);
  expect(launched).toEqual([]);
});

test("every Bot's view carries the name its machine hands out next, whichever Bot spent the last", async () => {
  const { project, secondProject, ref, registry } = await fixture();
  const first = await addBot(registry, { requestId: "add", name: "Captain", directoryPath: project }, { kind: "user" });
  const second = await addBot(
    registry,
    { requestId: "add-2", name: "Second", directoryPath: secondProject },
    { kind: "user" },
  );
  expect((await registry.snapshot()).bots.map((bot) => bot.nextAnchor)).toEqual(["Aaron", "Aaron"]);

  // One Bot spends a name; both now offer the next one, because the pool is the machine's.
  const attached = await addSessions(
    registry,
    first.botId,
    { requestId: "attach", sessionRefs: [ref] },
    { kind: "user" },
  );
  expect(attached.nextAnchor).toBe("Adam");
  const views = (await registry.snapshot()).bots;
  expect(views.find((bot) => bot.botId === second.botId)!.nextAnchor).toBe("Adam");
});

test("a session started elsewhere attaches before the catalog has seen it, and reads as missing", async () => {
  // A handover starts a Claude session whose transcript does not exist until its first turn
  // lands. `addSessions` refuses that reference; this door takes it, the way a launch does.
  const { registry, project } = await fixture();
  const bot = await addBot(
    registry,
    { requestId: "r1", name: "Handover bot", directoryPath: project },
    { kind: "user" },
  );
  const ref = { source: "claude" as const, sessionId: "handed-over" };
  await expect(
    addSessions(registry, bot.botId, { requestId: "r2", sessionRefs: [ref] }, { kind: "user" }),
  ).rejects.toBeInstanceOf(BotNotFoundError);

  const attached = await registry.attachStartedSession(bot.botId, ref, { kind: "user" });
  expect(attached.missingSessionRefs).toEqual([ref]);
  // A second attach of the same session is the same answer, not a second reference.
  const again = await registry.attachStartedSession(bot.botId, ref, { kind: "user" });
  expect(again.missingSessionRefs).toEqual([ref]);
});
