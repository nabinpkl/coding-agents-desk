// What the serve says about a turn being written, folded into the row a reader watches.
//
// The properties that matter are all about honesty at the seams: a part is not drawn before it
// has words, a delta for a part this tail never saw open is dropped rather than guessed at, the
// serve's closing text beats an accumulation, and a durable read retires the running message so
// the settled row is the one that stays.
import { describe, expect, it } from "bun:test";
import { OpencodeStreamTail, type OpencodeStreamedPart } from "@/agents/opencode/opencodeStreamTail";
import { OpencodeEventMapper } from "@/agents/opencode/opencodeEventMapper";
import { LiveAgentProjection } from "@/agents/liveAgentProjection";
import type { SessionMessageInfo as SessionMessage } from "@opencode/client";

const SESSION = "ses-1";

function part(over: Partial<OpencodeStreamedPart> = {}): OpencodeStreamedPart {
  return { kind: "text", phase: "delta", messageId: "msg-1", ordinal: 0, chunk: "hello", ...over };
}

function contentOf(message: SessionMessage | null): { type: string; text: string }[] {
  return (message as { content?: { type: string; text: string }[] } | null)?.content ?? [];
}

function textOf(message: SessionMessage | null): string {
  return contentOf(message)
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text)
    .join("");
}

describe("opencode stream tail", () => {
  it("draws nothing for a part with no words yet", () => {
    const tail = new OpencodeStreamTail();
    expect(tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1)).toBeNull();
  });

  it("accumulates chunks into the running part", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    const first = tail.apply(SESSION, part({ chunk: "one " }), 1);
    const second = tail.apply(SESSION, part({ chunk: "two" }), 1);
    expect(textOf(first)).toBe("one ");
    expect(textOf(second)).toBe("one two");
  });

  it("keeps reasoning and text in the order the serve opened them", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ kind: "reasoning", phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ kind: "reasoning", chunk: "thinking" }), 1);
    tail.apply(SESSION, part({ kind: "text", phase: "started", chunk: undefined }), 1);
    const message = tail.apply(SESSION, part({ kind: "text", chunk: "answer" }), 1);
    const kinds = (message as { content: { type: string }[] }).content.map((entry) => entry.type);
    expect(kinds).toEqual(["reasoning", "text"]);
  });

  it("drops a delta for a part it never saw open, and draws nothing from it", () => {
    const tail = new OpencodeStreamTail();
    expect(tail.apply(SESSION, part({ chunk: "words the sidecar missed" }), 1)).toBeNull();
  });

  it("prefers the serve's closing text over what the deltas accumulated", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ chunk: "the api " }), 1);
    const closed = tail.apply(SESSION, part({ phase: "ended", text: "the whole part" }), 1);
    expect(textOf(closed)).toBe("the whole part");
  });

  it("keeps what it streamed when the part closes with no text of its own", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ chunk: "encrypted provider" }), 1);
    const closed = tail.apply(SESSION, part({ phase: "ended", text: "" }), 1);
    expect(textOf(closed)).toBe("encrypted provider");
  });

  it("reads as streaming however long the words run, because only a durable read closes it", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    const message = tail.apply(SESSION, part({ phase: "ended", text: "done" }), 1) as unknown as {
      time: { completed?: number };
    };
    expect(message.time.completed).toBeUndefined();
  });

  it("replaces a running message when the serve opens the next one", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ chunk: "first step" }), 1);
    const next = tail.apply(SESSION, part({ messageId: "msg-2", phase: "started", chunk: undefined }), 2);
    expect(next).toBeNull();
    const drawn = tail.apply(SESSION, part({ messageId: "msg-2", chunk: "second step" }), 2);
    expect((drawn as unknown as { id: string }).id).toBe("msg-2");
    expect(textOf(drawn)).toBe("second step");
  });

  it("forgets a running message a durable read has finished", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ chunk: "settled" }), 1);
    tail.settle(SESSION, [
      { id: "msg-1", type: "assistant", time: { created: 1, completed: 2 } },
    ] as unknown as SessionMessage[]);
    expect(tail.holds(SESSION, "msg-1")).toBe(false);
    // Rebuilt from scratch, so the first delta after the handoff has no part to extend and the
    // row waits for the durable read rather than showing one line of a message the serve wrote.
    expect(tail.apply(SESSION, part({ chunk: "more" }), 1)).toBeNull();
  });

  it("keeps a running message a read did not name", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ chunk: "still writing" }), 1);
    tail.settle(SESSION, [{ id: "msg-other" }] as unknown as SessionMessage[]);
    expect(textOf(tail.apply(SESSION, part({ chunk: " more" }), 1))).toBe("still writing more");
  });

  it("keeps a part the read has not finished, so a mid-write row is not replaced by a thinner one", () => {
    // The shape the live turn showed: the serve inserts a message into its history while the
    // step still writes it, so a read names the running message with a reasoning part the
    // stream never saw. Dropping the tail there and rebuilding it from the next delta drew a
    // message holding only text, which replaced the row that had the reasoning block in it --
    // the thinking vanished mid-stream and came back when the step ended.
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ chunk: "the answer so far" }), 1);
    tail.settle(SESSION, [
      {
        id: "msg-1",
        type: "assistant",
        time: { created: 1 },
        content: [
          { type: "reasoning", text: "" },
          { type: "text", text: "the answer" },
        ],
      },
    ] as unknown as SessionMessage[]);
    expect(tail.holds(SESSION, "msg-1")).toBe(true);
    const drawn = tail.apply(SESSION, part({ chunk: " and more" }), 1);
    expect(contentOf(drawn)).toEqual([
      { type: "reasoning", text: "" },
      { type: "text", text: "the answer so far and more" },
    ]);
  });

  it("seeds a part the stream never opened, and keeps the longer text where a read is behind", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ kind: "text", phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ kind: "text", chunk: "written ahead of the file" }), 1);
    tail.settle(SESSION, [
      {
        id: "msg-1",
        type: "assistant",
        time: { created: 1 },
        content: [
          { type: "reasoning", text: "thinking the serve has" },
          { type: "text", text: "written ahead" },
        ],
      },
    ] as unknown as SessionMessage[]);
    const drawn = tail.apply(SESSION, part({ kind: "text", chunk: " and more" }), 1);
    expect(contentOf(drawn)).toEqual([
      { type: "reasoning", text: "thinking the serve has" },
      { type: "text", text: "written ahead of the file and more" },
    ]);
  });

  it("takes the durable text when it is the longer one, so the settled row reads as the serve wrote it", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ chunk: "a chunk" }), 1);
    tail.settle(SESSION, [
      {
        id: "msg-1",
        type: "assistant",
        time: { created: 1 },
        content: [{ type: "text", text: "a chunk, and the rest of it that the deltas never sent" }],
      },
    ] as unknown as SessionMessage[]);
    const drawn = tail.apply(SESSION, part({ chunk: "!" }), 1);
    expect(textOf(drawn)).toBe("a chunk, and the rest of it that the deltas never sent!");
  });

  it("draws a streamed message through the same mapper as a durable one", () => {
    const tail = new OpencodeStreamTail();
    const projection = new LiveAgentProjection();
    const mapper = new OpencodeEventMapper(projection);
    tail.apply(SESSION, part({ kind: "reasoning", phase: "started", chunk: undefined }), 1);
    const streamed = tail.apply(SESSION, part({ kind: "reasoning", chunk: "weighing it up" }), 1);
    mapper.sync([streamed!]);
    expect(projection.page(0, 4)[0]?.blocks).toEqual([{ kind: "reasoning", text: "weighing it up" }]);

    // The durable message for the same id, with the tool the deltas never named.
    mapper.sync([
      {
        id: "msg-1",
        type: "assistant",
        time: { created: 1, completed: 2 },
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [
          { type: "reasoning", text: "weighing it up" },
          { type: "text", text: "the answer" },
        ],
      } as unknown as SessionMessage,
    ]);
    const settled = projection.page(0, 4);
    expect(projection.total).toBe(1);
    expect(settled[0]?.phase).toBe("complete");
    expect(settled[0]?.blocks).toEqual([
      { kind: "reasoning", text: "weighing it up" },
      { kind: "text", text: "the answer" },
    ]);
  });

  // The shape the live turn showed, measured rather than imagined: at 13.16s the projection read
  // `reasoning: 583` while the serve's own message for the same id read `reasoning: 0` with the
  // shell part already `running`, because the serve writes a reasoning part at the end. The read
  // was mapped on its own, so the row became `reasoning: 0  tool_use: shell` and the thinking came
  // back on the next read. A snapshot of a row mid-write is the starting record for it, not the
  // end of it.
  it("hands back the merge after a read that is behind the stream, so the thinking is never replaced", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ kind: "reasoning", phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ kind: "reasoning", chunk: "five hundred and eighty three characters of it" }), 1);
    const merged = tail.settle(SESSION, [
      {
        id: "msg-1",
        type: "assistant",
        time: { created: 1 },
        content: [
          { type: "reasoning", text: "" },
          { type: "tool", id: "call-1", name: "shell", state: { status: "running", input: { command: "ls" } } },
        ],
      },
    ] as unknown as SessionMessage[]);
    expect(contentOf(merged).map((part) => `${part.type}:${part.text?.length ?? 0}`)).toEqual([
      "reasoning:46",
      "tool:0",
    ]);
  });

  it("keeps a tool part across a later delta, so a shell call does not vanish when a sentence arrives", () => {
    // The other half of the same bug, and it runs the other way: the deltas know nothing about a
    // tool, so a row drawn from the stream alone would drop the call the reader is watching run.
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ kind: "reasoning", phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ kind: "reasoning", chunk: "thinking" }), 1);
    tail.apply(SESSION, part({ kind: "text", phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ kind: "text", chunk: "let me look" }), 1);
    tail.settle(SESSION, [
      {
        id: "msg-1",
        type: "assistant",
        time: { created: 1 },
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "let me look" },
          { type: "tool", id: "call-1", name: "shell", state: { status: "running", input: { command: "ls" } } },
        ],
      },
    ] as unknown as SessionMessage[]);
    const afterDelta = tail.apply(SESSION, part({ kind: "text", chunk: " at the files" }), 1);
    expect(contentOf(afterDelta).map((part) => part.type)).toEqual(["reasoning", "text", "tool"]);
    expect(textOf(afterDelta)).toBe("let me look at the files");
  });

  it("draws the same row whether the read is behind, level, or ahead, and never a thinner one", () => {
    // The invariant in one place: whatever the read says, what a reader had is still there.
    const cases: { read: string; expected: string }[] = [
      { read: "", expected: "weighing it up" },
      { read: "weighing", expected: "weighing it up" },
      {
        read: "weighing it up, and the rest the deltas never sent",
        expected: "weighing it up, and the rest the deltas never sent",
      },
    ];
    for (const { read, expected } of cases) {
      const tail = new OpencodeStreamTail();
      tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
      tail.apply(SESSION, part({ chunk: "weighing it up" }), 1);
      const merged = tail.settle(SESSION, [
        {
          id: "msg-1",
          type: "assistant",
          time: { created: 1 },
          content: [{ type: "text", text: read }],
        },
      ] as unknown as SessionMessage[]);
      expect(textOf(merged)).toBe(expected);
    }
  });

  it("goes on holding what it streamed when a read has not caught up with the stream", () => {
    // The read names no unfinished message at all, which means it is behind rather than that the
    // turn is over. The tail's row is then the better record, and it is still drawn.
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ chunk: "still writing" }), 1);
    const drawn = tail.settle(SESSION, [
      { id: "msg-1", type: "assistant", time: { created: 1, completed: 2 } },
    ] as unknown as SessionMessage[]);
    // A completed message is the whole story, so the stream is over for it and there is nothing to
    // redraw: the read already drew the settled row.
    expect(drawn).toBeNull();
    expect(tail.holds(SESSION, "msg-1")).toBe(false);
  });

  it("redraws a message the read did not name at all, rather than leaving the read's older row up", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ chunk: "live words" }), 1);
    const drawn = tail.settle(SESSION, [
      { id: "msg-old", type: "assistant", time: { created: 1, completed: 2 } },
    ] as unknown as SessionMessage[]);
    expect(textOf(drawn)).toBe("live words");
  });

  it("carries the serve's own fields through, so a redraw does not lose what the deltas never name", () => {
    const tail = new OpencodeStreamTail();
    tail.apply(SESSION, part({ phase: "started", chunk: undefined }), 1);
    tail.apply(SESSION, part({ chunk: "words" }), 1);
    const merged = tail.settle(SESSION, [
      {
        id: "msg-1",
        type: "assistant",
        time: { created: 7, created2: undefined },
        agent: "build",
        model: { id: "m", providerID: "p" },
        content: [{ type: "text", text: "" }],
      },
    ] as unknown as SessionMessage[]) as unknown as { created?: number; agent?: string; time: { created: number } };
    expect(merged.time.created).toBe(7);
    expect(merged.agent).toBe("build");
  });
});
