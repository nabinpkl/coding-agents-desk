// Whether a Bot and its sessions stand on the canvas: stored on the record, and nowhere else.

import { expect, test } from "bun:test";
import { BotForbiddenError, BotInvalidError, BotNotFoundError } from "@/bots/botRegistry";
import { botRegistryHarness } from "@/bots/botRegistryHarness";

const { addBot, addSessions, fixture } = botRegistryHarness();

async function botWithTwo() {
  const { registry, project, ref, secondRef, claudeRef } = await fixture();
  const created = await addBot(
    registry,
    { requestId: "r1", name: "Canvas bot", directoryPath: project },
    { kind: "user" },
  );
  const bot = await addSessions(
    registry,
    created.botId,
    { requestId: "r2", sessionRefs: [ref, secondRef] },
    { kind: "user" },
  );
  return { registry, botId: bot.botId, ref, secondRef, claudeRef };
}

test("a Bot nobody has touched carries neither field", async () => {
  const { registry } = await botWithTwo();
  const [bot] = (await registry.snapshot()).bots;
  expect("offCanvas" in bot!).toBe(false);
  expect("offCanvasSessionRefs" in bot!).toBe(false);
});

test("takes a Bot off and puts it back, and the record is what remembers", async () => {
  const { registry, botId } = await botWithTwo();

  const off = await registry.setCanvas(botId, { onCanvas: false }, { kind: "user" });
  expect(off.offCanvas).toBe(true);
  expect((await registry.snapshot()).bots[0]!.offCanvas).toBe(true);

  const on = await registry.setCanvas(botId, { onCanvas: true }, { kind: "user" });
  expect("offCanvas" in on).toBe(false);
});

test("takes sessions off in the Bot's own order, and a repeat changes nothing", async () => {
  const { registry, botId, ref, secondRef } = await botWithTwo();
  const off = { onCanvas: false };

  await registry.setCanvas(
    botId,
    {
      sessions: [
        { ...secondRef, ...off },
        { ...ref, ...off },
      ],
    },
    { kind: "user" },
  );
  const again = await registry.setCanvas(botId, { sessions: [{ ...ref, ...off }] }, { kind: "user" });
  expect(again.offCanvasSessionRefs?.map((each) => each.sessionId)).toEqual(["session-1", "session-2"]);

  const back = await registry.setCanvas(
    botId,
    {
      sessions: [
        { ...ref, onCanvas: true },
        { ...secondRef, onCanvas: true },
      ],
    },
    { kind: "user" },
  );
  expect("offCanvasSessionRefs" in back).toBe(false);
});

test("forgets a session's place off the canvas when the Bot lets it go", async () => {
  // Kept, it would hide the session again the next time it was attached, on a card that never said.
  const { registry, botId, ref, secondRef } = await botWithTwo();
  await registry.setCanvas(
    botId,
    {
      sessions: [
        { ...ref, onCanvas: false },
        { ...secondRef, onCanvas: false },
      ],
    },
    { kind: "user" },
  );
  const detached = await registry.detachSessions(botId, { requestId: "r3", sessionRefs: [ref] }, { kind: "user" });
  expect(detached.offCanvasSessionRefs?.map((each) => each.sessionId)).toEqual(["session-2"]);
});

test("refuses a session the Bot does not hold, and a command that changes nothing", async () => {
  const { registry, botId, claudeRef } = await botWithTwo();
  await expect(
    registry.setCanvas(botId, { sessions: [{ ...claudeRef, onCanvas: false }] }, { kind: "user" }),
  ).rejects.toBeInstanceOf(BotNotFoundError);
  await expect(registry.setCanvas(botId, {}, { kind: "user" })).rejects.toBeInstanceOf(BotInvalidError);
  await expect(
    registry.setCanvas(botId, { onCanvas: "no" as unknown as boolean }, { kind: "user" }),
  ).rejects.toBeInstanceOf(BotInvalidError);
});

test("is the authenticated user's alone", async () => {
  const { registry, botId } = await botWithTwo();
  await expect(
    registry.setCanvas(botId, { onCanvas: false }, { kind: "agent", session: { source: "claude", sessionId: "x" } }),
  ).rejects.toBeInstanceOf(BotForbiddenError);
});

test("stands a Bot at a position on the strip, and refuses one that is not a place", async () => {
  const { registry, botId } = await botWithTwo();
  const placed = await registry.setCanvas(botId, { position: 3 }, { kind: "user" });
  expect(placed.canvasPosition).toBe(3);
  expect((await registry.snapshot()).bots[0]!.canvasPosition).toBe(3);
  for (const position of [-1, 1.5, "2" as unknown as number]) {
    await expect(registry.setCanvas(botId, { position }, { kind: "user" })).rejects.toBeInstanceOf(BotInvalidError);
  }
});

test("puts a Bot on another canvas with the sessions it shows there, and null takes it off", async () => {
  const { registry, botId, ref, secondRef } = await botWithTwo();
  // Named out of order: the record keeps the Bot's own order, as it does for off-canvas sessions.
  const on = await registry.setCanvas(botId, { canvases: { branches: [secondRef, ref] } }, { kind: "user" });
  expect(on.canvases?.branches?.sessionRefs.map((each) => each.sessionId)).toEqual(["session-1", "session-2"]);
  expect((await registry.snapshot()).bots[0]!.canvases?.branches?.sessionRefs).toHaveLength(2);

  // A Bot can stand on one with none of its sessions showing.
  const bare = await registry.setCanvas(botId, { canvases: { branches: [] } }, { kind: "user" });
  expect(bare.canvases?.branches?.sessionRefs).toEqual([]);

  const off = await registry.setCanvas(botId, { canvases: { branches: null } }, { kind: "user" });
  expect("canvases" in off).toBe(false);
});

test("refuses a canvas that does not exist, and a session the Bot does not hold", async () => {
  const { registry, botId, claudeRef } = await botWithTwo();
  const unknown = { elsewhere: [] } as unknown as Record<"branches", []>;
  await expect(registry.setCanvas(botId, { canvases: unknown }, { kind: "user" })).rejects.toBeInstanceOf(
    BotInvalidError,
  );
  await expect(
    registry.setCanvas(botId, { canvases: { branches: [claudeRef] } }, { kind: "user" }),
  ).rejects.toBeInstanceOf(BotNotFoundError);
});

test("takes a session the Bot lets go off every canvas it was shown on", async () => {
  const { registry, botId, ref, secondRef } = await botWithTwo();
  await registry.setCanvas(botId, { canvases: { branches: [ref, secondRef] } }, { kind: "user" });
  const detached = await registry.detachSessions(botId, { requestId: "r3", sessionRefs: [ref] }, { kind: "user" });
  expect(detached.canvases?.branches?.sessionRefs.map((each) => each.sessionId)).toEqual(["session-2"]);
});
