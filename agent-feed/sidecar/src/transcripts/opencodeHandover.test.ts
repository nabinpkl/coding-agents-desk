import { expect, test } from "bun:test";
import type { SessionMessageInfo as SessionMessage } from "@opencode/client";
import { renderOpencodeHandover } from "@/transcripts/opencodeHandover";
import { SessionHandoverError } from "@/transcripts/sessionHandover";

/**
 * The two things this file exists to pin, both of which fail silently and look like a handover
 * that worked: cutting at the wrong compaction, and handing over the summary the FEED was given
 * instead of the one the serve holds.
 */
function user(id: string, text: string, created: number): SessionMessage {
  return { id, type: "user", text, time: { created } };
}

function compaction(
  id: string,
  summary: string,
  created: number,
  status?: "running" | "completed" | "failed",
): SessionMessage {
  return {
    id,
    type: "compaction",
    reason: "auto",
    summary,
    recent: "recent context",
    time: { created },
    ...(status === undefined ? {} : { status }),
  } as unknown as SessionMessage;
}

function history(messages: SessionMessage[]) {
  return async () => messages;
}

test("carries the summary and every turn after the compaction, and nothing before it", async () => {
  const rendered = await renderOpencodeHandover(
    "oc_1",
    history([
      user("m1", "before the boundary", 100),
      compaction("m2", "Primary request: fix the wire.", 200),
      user("m3", "did it land?", 300),
    ]),
  );
  expect(rendered.summary).toBe("Primary request: fix the wire.");
  expect(rendered.turnCount).toBe(1);
  expect(rendered.turns).toContain("did it land?");
  expect(rendered.turns).not.toContain("before the boundary");
});

test("reads the summary off the serve rather than the row, so the feed's cap does not reach it", async () => {
  // The mapper caps a row's text at 8000 characters, which is right for something nobody has to
  // act on and wrong for the one part of a handover that states what the reader is looking at.
  // Measured on this project's own compacted transcripts, a real summary runs 16KB to 28KB, so
  // taking the row's copy would silently cut a third to two thirds of it.
  const summary = "S".repeat(20_000);
  const rendered = await renderOpencodeHandover(
    "oc_2",
    history([compaction("m1", summary, 100), user("m2", "carry on", 200)]),
  );
  expect(rendered.summary).toBe(summary);
  expect(rendered.summary?.length).toBe(20_000);
});

test("cuts at the newest landed compaction, not the first and not a retry that did not land", async () => {
  // A long session compacts more than once, and a compaction that fails is retried under a new
  // message. Cutting at either of the wrong ones hands over a context the session no longer has.
  const rendered = await renderOpencodeHandover(
    "oc_3",
    history([
      compaction("m1", "the old summary", 100),
      user("m2", "work done under the old context", 200),
      compaction("m3", "the summary in force", 300),
      user("m4", "work done since", 400),
      compaction("m5", "a summary still being written", 500, "running"),
    ]),
  );
  expect(rendered.summary).toBe("the summary in force");
  expect(rendered.turnCount).toBe(1);
  expect(rendered.turns).toContain("work done since");
  expect(rendered.turns).not.toContain("work done under the old context");
});

test("orders by the serve's own clock, since history pages do not arrive in order", async () => {
  const rendered = await renderOpencodeHandover(
    "oc_4",
    history([user("m3", "second", 300), compaction("m1", "the summary", 100), user("m2", "first", 200)]),
  );
  expect(rendered.turnCount).toBe(2);
  expect(rendered.turns.indexOf("first")).toBeLessThan(rendered.turns.indexOf("second"));
});

test("hands over every turn of a session that was never compacted", async () => {
  const rendered = await renderOpencodeHandover(
    "oc_5",
    history([user("m1", "hello", 100), user("m2", "goodbye", 200)]),
  );
  expect(rendered.summary).toBeNull();
  expect(rendered.turnCount).toBe(2);
  expect(rendered.turns.indexOf("hello")).toBeLessThan(rendered.turns.indexOf("goodbye"));
});

test("a compaction still running is not a boundary: the whole conversation goes", async () => {
  // The serve writes the checkpoint when compaction STARTS. Cutting there would carry a summary
  // the summariser has not finished, which reads as a complete handover of half a story.
  const rendered = await renderOpencodeHandover(
    "oc_6",
    history([user("m1", "hello", 100), compaction("m2", "half a summary", 200, "running")]),
  );
  expect(rendered.summary).toBeNull();
  expect(rendered.turns).toContain("hello");
  expect(rendered.turns).not.toContain("half a summary");
});

test("refuses a landed compaction with no summary rather than handing over what it replaced", async () => {
  await expect(
    renderOpencodeHandover(
      "oc_7",
      history([user("m1", "summarised away", 100), compaction("m2", "", 200), user("m3", "after", 300)]),
    ),
  ).rejects.toBeInstanceOf(SessionHandoverError);
});

test("refuses a session with nothing said in it", async () => {
  await expect(renderOpencodeHandover("oc_8", history([]))).rejects.toBeInstanceOf(SessionHandoverError);
});
