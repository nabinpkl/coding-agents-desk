import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpeechQueue,
  lastAgentReply,
  replyOpening,
  speakableReply,
  speakerName,
  spokenAnnouncement,
  type SpeechTone,
} from "@/push/sessionSpeech";

function user(content: unknown): string {
  return JSON.stringify({ type: "user", uuid: crypto.randomUUID(), message: { role: "user", content } });
}

function assistant(content: unknown[]): string {
  return JSON.stringify({ type: "assistant", uuid: crypto.randomUUID(), message: { role: "assistant", content } });
}

const toolUse = { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } };
const toolResult = [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }];

let directory = "";
afterEach(() => rm(directory, { recursive: true, force: true }));

async function transcript(...lines: string[]): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "session-speech-"));
  const path = join(directory, "session.jsonl");
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

describe("the last reply of a finished turn", () => {
  test("is the newest text the agent wrote, past the tool calls after it", async () => {
    const path = await transcript(
      user("list the files"),
      assistant([{ type: "text", text: "Looking." }, toolUse]),
      user(toolResult),
      assistant([{ type: "text", text: "There is one file, a.txt." }]),
    );
    expect(await lastAgentReply(path)).toBe("There is one file, a.txt.");
  });

  test("is nothing when the turn's agent wrote no text, rather than the turn before's", async () => {
    const path = await transcript(
      user("first"),
      assistant([{ type: "text", text: "An older reply." }]),
      user("second"),
      assistant([toolUse]),
      user(toolResult),
    );
    expect(await lastAgentReply(path)).toBeNull();
  });
});

describe("what is said", () => {
  const block = {
    from: "block" as const,
    at: 1,
    lines: [
      { kind: "waiting" as const, text: "say go to rebuild the host" },
      { kind: "done" as const, text: "the slider reaches four times" },
    ],
  };

  test("is the Bot's name, then each status line introduced by its kind", () => {
    expect(spokenAnnouncement("AD bot", "finished", block, null)).toBe(
      "AD bot. Needs you: say go to rebuild the host. the slider reaches four times.",
    );
  });

  test("without a block, is the reply's first two sentences, not the whole reply", () => {
    const reply = "Done: the slider works. It reaches four times. Here is a lot more detail nobody hears.";
    expect(spokenAnnouncement("AD bot", "finished", undefined, reply)).toBe(
      "AD bot. Done: the slider works. It reaches four times.",
    );
  });

  test("for a question, and a reminder of one, is the question", () => {
    const question = { from: "question" as const, at: 1, lines: [{ kind: "waiting" as const, text: "Rebuild now?" }] };
    expect(spokenAnnouncement("AD bot", "question", question, null)).toBe("AD bot. Asks: Rebuild now?");
    expect(spokenAnnouncement("AD bot", "reminder", question, null)).toBe(
      "AD bot. Still waiting on you. Asks: Rebuild now?",
    );
  });

  test("names code instead of reading it, and drops markup", () => {
    const said = speakableReply(
      "## Done\n\nRan `just check`:\n\n```sh\njust check\n```\n\n- **all** green, see [the log](http://x)",
    );
    expect(said).toBe("Done Ran just check: (code) all green, see the log");
  });

  test("keeps a sentence that quotes punctuation whole", () => {
    expect(replyOpening('You sent only "..", so I have no task. I am a branch. Tell me more.')).toBe(
      'You sent only "..", so I have no task. I am a branch.',
    );
  });

  test("leaves the session's own blocks out of a reply's opening", () => {
    expect(replyOpening("<task-state>\ntask: x\n</task-state>\n\nIt works now. More.")).toBe("It works now. More.");
  });

  test("names the session after its Bot when the Bot gave it a name", () => {
    const session = { source: "claude" as const, sessionId: "s1", project: "/p", lastEventAt: 0 };
    const bot = { name: "Agent Desk", sessionAnchors: { "claude:s1": "Alan" } };
    expect(speakerName(bot, session)).toBe("Agent Desk, Alan");
    expect(speakerName({ name: "Agent Desk." }, session)).toBe("Agent Desk");
    expect(spokenAnnouncement(speakerName(bot, session), "finished", undefined, "Done.")).toBe(
      "Agent Desk, Alan. Done.",
    );
  });
});

describe("the queue", () => {
  test("puts what needs the person first, and keeps only a Bot's newest", async () => {
    const said: string[] = [];
    let release: () => void = () => {};
    const first = new Promise<void>((resolve) => (release = resolve));
    const queue = createSpeechQueue((text: string, tone: SpeechTone) => {
      said.push(`${text}/${tone}`);
      return said.length === 1 ? first : Promise.resolve();
    });
    const done = queue.enqueue("a", "A one", "done", false);
    void queue.enqueue("b", "B old", "done", false);
    void queue.enqueue("c", "C needs you", "attention", true);
    void queue.enqueue("b", "B new", "done", false);
    release();
    await done;
    expect(said).toEqual(["A one/done", "C needs you/attention", "B new/done"]);
  });
});
