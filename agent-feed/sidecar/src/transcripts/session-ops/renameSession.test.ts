import { describe, expect, test } from "bun:test";
import {
  renameClaudeSession,
  SessionRenameNotFoundError,
  SessionRenameUnavailableError,
  type RenameSteps,
} from "@/transcripts/session-ops/renameSession";

function steps(serving: boolean, reply: { ok: true } | { ok: false; reason: "failed"; message: string } = { ok: true }) {
  const done: string[] = [];
  const fake: RenameSteps = {
    sdk: {
      isServing: async () => serving,
      command: async (_sessionId, command) => {
        done.push(`runner ${command.type} ${command.type === "rename" ? command.title : ""}`.trim());
        return reply;
      },
    },
    known: (sessionId) => sessionId !== "gone",
    inPane: async (_sessionId, title) => {
      done.push(`pane /rename ${title}`);
      return { renamed: true } as Awaited<ReturnType<RenameSteps["inPane"]>>;
    },
    relabel: async (_sessionId, title) => void done.push(`relabel ${title}`),
  };
  return { done, steps: fake };
}

describe("renaming a session", () => {
  test("goes through its runner when it runs through the SDK, and never types into its pane", async () => {
    const { done, steps: s } = steps(true);
    expect(await renameClaudeSession("s1", "  Garden notes ", s)).toBe("Garden notes");
    expect(done).toEqual(["runner rename Garden notes", "relabel Garden notes"]);
  });

  test("is typed into the pane for a terminal session", async () => {
    const { done, steps: s } = steps(false);
    await renameClaudeSession("s1", "Garden notes", s);
    expect(done).toEqual(["pane /rename Garden notes", "relabel Garden notes"]);
  });

  test("says so when the runner refuses it, and renames nothing", async () => {
    const { done, steps: s } = steps(true, { ok: false, reason: "failed", message: "the session has ended" });
    await expect(renameClaudeSession("s1", "Garden notes", s)).rejects.toBeInstanceOf(SessionRenameUnavailableError);
    expect(done).toEqual(["runner rename Garden notes"]);
  });

  test("refuses a session the catalog does not hold", async () => {
    await expect(renameClaudeSession("gone", "Garden notes", steps(true).steps)).rejects.toBeInstanceOf(SessionRenameNotFoundError);
  });
});
