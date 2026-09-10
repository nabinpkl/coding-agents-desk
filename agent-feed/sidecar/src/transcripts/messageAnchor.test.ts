// The records here are the shapes a real Claude transcript holds, including the ones that are
// `type: "user"` and are not a person: a tool result, and a harness envelope. Those two are the
// whole reason this module counts through `isHumanTurnStart` rather than through `type` alone, so
// a fixture without them would prove nothing.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  anchorAtLine,
  lastCompactionMessage,
  lineFromEventId,
  MessageAnchorError,
} from "@/transcripts/messageAnchor";

const roots: string[] = [];
const SESSION = "99999999-9999-4999-8999-999999999999";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function said(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    cwd: "/tmp/project",
    timestamp: "2026-09-09T05:00:00.000Z",
    uuid: crypto.randomUUID(),
  });
}

function toolResult(): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ tool_use_id: "toolu_1", type: "tool_result", content: "ok" }],
    },
    cwd: "/tmp/project",
    timestamp: "2026-09-09T05:00:01.000Z",
    uuid: crypto.randomUUID(),
  });
}

function replied(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    cwd: "/tmp/project",
    timestamp: "2026-09-09T05:00:02.000Z",
    uuid: crypto.randomUUID(),
  });
}

/**
 * The two records a compaction writes, in the order the CLI writes them.
 *
 * Both are needed: the boundary is a `system` record and the summary is a `user` one carrying
 * `isCompactSummary`, and a resolver that knew only one of them would find the wrong line by
 * however far apart they sit.
 */
function compacted(): readonly string[] {
  return [
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      compactMetadata: { trigger: "manual", preTokens: 100000 },
      cwd: "/tmp/project",
      timestamp: "2026-09-09T05:00:03.000Z",
      uuid: crypto.randomUUID(),
    }),
    JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { role: "user", content: "This session is being continued from a previous..." },
      cwd: "/tmp/project",
      timestamp: "2026-09-09T05:00:04.000Z",
      uuid: crypto.randomUUID(),
    }),
  ];
}

async function transcript(lines: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "message-anchor-"));
  roots.push(root);
  const path = join(root, `${SESSION}.jsonl`);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

/**
 * Three messages with the noise a real transcript carries between them.
 *
 * Message lines land at 0, 3 and 6, and every other line is something the picker will not offer.
 */
function conversation(): readonly string[] {
  return [
    said("ALPHA one"),
    replied("OK"),
    toolResult(),
    said("BRAVO two"),
    replied("OK"),
    said("<system-reminder>a thing the harness injected</system-reminder>"),
    said("CHARLIE three"),
    replied("OK"),
  ];
}

test("counts messages from the end, the way the picker is addressed", async () => {
  const path = await transcript(conversation());

  expect(await anchorAtLine(SESSION, path, 6)).toEqual({ fromEnd: 1, text: "CHARLIE three" });
  expect(await anchorAtLine(SESSION, path, 3)).toEqual({ fromEnd: 2, text: "BRAVO two" });
  expect(await anchorAtLine(SESSION, path, 0)).toEqual({ fromEnd: 3, text: "ALPHA one" });
});

test("a tool result is not a message, however the transcript labels it", async () => {
  // The scar this repository already carries: a summarizer read a tool result as the person
  // speaking because it tested `type === "user"` alone. Counting it here would put every anchor
  // before it off by one.
  const path = await transcript(conversation());
  await expect(anchorAtLine(SESSION, path, 2)).rejects.toBeInstanceOf(MessageAnchorError);
});

test("a harness envelope is not a message either", async () => {
  const path = await transcript(conversation());
  await expect(anchorAtLine(SESSION, path, 5)).rejects.toBeInstanceOf(MessageAnchorError);
  // And it is not counted, which is what the offsets above already assert: CHARLIE is one back
  // from the end rather than two.
});

test("an assistant line is not something to fork from", async () => {
  const path = await transcript(conversation());
  await expect(anchorAtLine(SESSION, path, 1)).rejects.toBeInstanceOf(MessageAnchorError);
});

test("refuses a line that is not in the file at all", async () => {
  const path = await transcript(conversation());
  await expect(anchorAtLine(SESSION, path, 99)).rejects.toBeInstanceOf(MessageAnchorError);
});

test("reads an event id the way the event index writes one", () => {
  expect(lineFromEventId(`claude:${SESSION}:line:42`, SESSION)).toBe(42);
  // The id the panel holds is lower-case already, but the route lower-cases its path and a caller
  // may not have, so neither side decides the other's casing.
  expect(lineFromEventId(`claude:${SESSION.toUpperCase()}:line:7`, SESSION)).toBe(7);
});

test("refuses an event that belongs to another session", () => {
  // A panel that sent the row it was looking at while the reader had moved on would otherwise
  // anchor into a transcript nobody asked about, and the count would be valid nonsense.
  expect(() => lineFromEventId("claude:11111111-1111-4111-8111-111111111111:line:3", SESSION))
    .toThrow(MessageAnchorError);
});

test("refuses an id that is not one, and a source that cannot be forked", () => {
  expect(() => lineFromEventId("nonsense", SESSION)).toThrow(MessageAnchorError);
  expect(() => lineFromEventId(`codex:${SESSION}:line:3`, SESSION)).toThrow(MessageAnchorError);
});

test("finds the first thing said after the newest compaction", async () => {
  // Two compactions, so the answer has to be the newer one rather than the first one found walking
  // forwards. The envelope after it is what a real `/compact` leaves behind and is not the answer.
  const path = await transcript([
    said("ALPHA one"),
    ...compacted(),
    said("BRAVO two"),
    replied("OK"),
    ...compacted(),
    said("<local-command-stdout>Compacted</local-command-stdout>"),
    toolResult(),
    said("CHARLIE three"),
    replied("OK"),
    said("DELTA four"),
  ]);

  const found = await lastCompactionMessage(SESSION, path);

  expect(found?.text).toBe("CHARLIE three");
  // Addressed the way the fork command takes it, so the panel hands this straight back.
  expect(found?.eventId).toBe(`claude:${SESSION}:line:9`);
  // And it is an anchor the picker can actually be walked to: two messages sit after it.
  expect(await anchorAtLine(SESSION, path, 9)).toEqual({ fromEnd: 2, text: "CHARLIE three" });
});

test("a session that was never compacted has no such point", async () => {
  expect(await lastCompactionMessage(SESSION, await transcript(conversation()))).toBeNull();
});

test("a compaction nobody has spoken since has no such point either", async () => {
  // Not a failure: every compact boundary is written with `parentUuid: null`, so a fork already
  // starts at the last compaction, and with nothing said after it the ordinary fork IS this.
  const path = await transcript([said("ALPHA one"), replied("OK"), ...compacted()]);

  expect(await lastCompactionMessage(SESSION, path)).toBeNull();
});
