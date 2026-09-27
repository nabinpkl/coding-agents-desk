import { afterEach, describe, expect, it } from "bun:test";
import {
  askOpencodeAside,
  currentWindowTokens,
  exportOpencodeSession,
  forkOpencodeSession,
  lastCompletedCompactionIndex,
  LOCAL_OPENCODE_COMMANDS,
} from "@/agents/opencode/opencodeServeCalls";

const assistant = (output: number, read: number) => ({
  type: "assistant",
  tokens: { input: 100, output, reasoning: 0, cache: { read, write: 0 } },
});

describe("currentWindowTokens", () => {
  it("reads the newest assistant message with tokens, not the session totals", () => {
    expect(
      currentWindowTokens([
        assistant(50, 1000),
        { type: "user" },
        assistant(216, 610929),
      ]),
    ).toBe(100 + 216 + 610929);
  });

  it("counts a running turn the TUI already shows, instead of holding the last finished one", () => {
    expect(
      currentWindowTokens([
        assistant(50, 1000),
        { type: "user" },
        // Streaming: input and cache reads land before any output does.
        { type: "assistant", tokens: { input: 629, output: 0, reasoning: 162, cache: { read: 219761, write: 0 } } },
      ]),
    ).toBe(629 + 0 + 162 + 219761);
  });

  it("reports nothing without a message carrying tokens", () => {
    expect(currentWindowTokens([{ type: "assistant", tokens: null }])).toBeNull();
    expect(currentWindowTokens([{ type: "assistant", tokens: { input: 0, output: 0 } }])).toBeNull();
    expect(currentWindowTokens([{ type: "user" }])).toBeNull();
    expect(currentWindowTokens([])).toBeNull();
  });
});

describe("lastCompletedCompactionIndex", () => {
  const completed = { type: "compaction", status: "completed" };

  it("ignores assistants at or before the boundary", () => {
    const before = assistant(216, 610929);
    const after = assistant(50, 1000);
    const messages = [before, { type: "user" }, completed, { type: "user" }, after];
    expect(lastCompletedCompactionIndex(messages)).toBe(2);
    // The pre-compaction 611K window is gone; only the post-boundary turn counts.
    expect(currentWindowTokens(messages)).toBe(100 + 50 + 1000);
  });

  it("blanks the gap: completed compaction with no tokens reported after it", () => {
    expect(
      currentWindowTokens([assistant(216, 610929), { type: "user" }, completed]),
    ).toBeNull();
  });

  it("a running or failed compaction moves no boundary", () => {
    const messages = [assistant(216, 610929), { type: "compaction", status: "running" }];
    expect(lastCompletedCompactionIndex(messages)).toBe(-1);
    expect(currentWindowTokens(messages)).toBe(100 + 216 + 610929);
    const failed = [assistant(216, 610929), { type: "compaction", status: "failed" }];
    expect(lastCompletedCompactionIndex(failed)).toBe(-1);
    expect(currentWindowTokens(failed)).toBe(100 + 216 + 610929);
  });

  it("the newest completed compaction wins", () => {
    const messages = [
      assistant(10, 10),
      completed,
      assistant(20, 20),
      { type: "compaction", status: "completed" },
    ];
    expect(lastCompletedCompactionIndex(messages)).toBe(3);
    expect(currentWindowTokens(messages)).toBeNull();
  });
});

describe("the mirrored web set", () => {
  it("lists the commands the panel can run, in the order the picker shows them", () => {
    // Names only: the descriptions are opencode's own strings, carried through rather than
    // restated here. `/models` is the one the panel added, as an alias rather than a second
    // command, so the row is the web client's `model` either way it is typed.
    expect(LOCAL_OPENCODE_COMMANDS.map((command) => command.name)).toEqual([
      "model", "new", "undo", "redo", "compact", "fork", "export", "btw", "rename",
    ]);
    expect(LOCAL_OPENCODE_COMMANDS.find((command) => command.name === "model")?.aliases).toEqual(["models"]);
    // Every row says what it does. A row with no description is a name a reader has to guess at.
    expect(LOCAL_OPENCODE_COMMANDS.every((command) => (command.description ?? "").length > 0)).toBe(true);
  });
});

describe("the two reads", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function serve(answers: Record<string, () => Response>) {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const answer = answers[Object.keys(answers).find((key) => path.endsWith(key)) ?? ""];
      asked.push(`${init?.method ?? "GET"} ${path} ${String(init?.body ?? "")}`);
      if (!answer) return new Response("not found", { status: 404 });
      return answer();
    }) as typeof fetch;
    return asked;
  }

  it("asks a side question with the TUI's own instruction, and answers with the text", async () => {
    const asked = serve({ generate: () => Response.json({ data: { text: "a side answer" } }) });
    await expect(askOpencodeAside("s1", "what did we decide?")).resolves.toBe("a side answer");
    // The instruction rides the prompt because `session.generate` runs no tool loop, so a tool
    // call there would surface as an empty answer.
    expect(asked[0]).toContain("POST /api/session/s1/generate");
    expect(asked[0]).toContain("Do not call any tools");
    expect(asked[0]).toContain("what did we decide?");
  });

  it("answers an export with the transcript, unwrapped from the serve's envelope", async () => {
    const asked = serve({ export: () => Response.json({ data: { info: { id: "s1" }, messages: [] } }) });
    await expect(exportOpencodeSession("s1")).resolves.toEqual({ info: { id: "s1" }, messages: [] });
    expect(asked[0]).toBe("GET /api/experimental/session/s1/export ");
  });

  it("refuses a shape the serve did not send, rather than answering with undefined", async () => {
    serve({ fork: () => Response.json({ data: { title: "no id here" } }) });
    await expect(forkOpencodeSession("s1")).rejects.toThrow("without a session id");
    serve({ generate: () => Response.json({ nope: true }) });
    await expect(askOpencodeAside("s1", "why")).rejects.toThrow("aside: serve answered without data");
  });
});
