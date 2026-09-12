import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { config } from "@/config";

// `config` is `as const`, so its fields are readonly to a reader and still assignable at runtime.
// Pointing it at a scratch directory is the only way to exercise the path derivation without
// writing into the real `~/.claude/projects`, and the original is restored after every case.
const mutableConfig = config as unknown as { claudeProjectsDirectory: string };
import { createSubagentRoutes } from "@/http/session-routes/subagentRoutes";

const SESSION = "7b20bcaf-f34b-4a32-bd0b-613c27cc3507";
const AGENT = "a6da370b26e85421c";

// The stream sets its own request timeout off. Only that one method is reached from here.
const server = { timeout: () => {} } as unknown as Server<undefined>;
const routes = createSubagentRoutes();

function get(path: string): Response | Promise<Response> | undefined {
  const url = new URL(`http://localhost${path}`);
  return routes(new Request(url.toString()), url, server);
}

/** The first SSE payload, which is all these cases need. */
async function firstMessage(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  const line = buffer.split("\n").find((candidate) => candidate.startsWith("data: "));
  return JSON.parse(line!.slice(6)) as Record<string, unknown>;
}

let root = "";
let previousProjects = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "subagent-routes-"));
  previousProjects = config.claudeProjectsDirectory;
  mutableConfig.claudeProjectsDirectory = root;
});

afterEach(() => {
  mutableConfig.claudeProjectsDirectory = previousProjects;
});

async function writeTranscripts(agentId: string, lines: unknown[]): Promise<void> {
  const project = join(root, "-a-project");
  await mkdir(join(project, SESSION, "subagents"), { recursive: true });
  // The parent must exist: the subagent's path is derived from where the parent was found, which
  // is what stops a caller naming a file.
  await writeFile(join(project, `${SESSION}.jsonl`), "");
  await writeFile(
    join(project, SESSION, "subagents", `agent-${agentId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}

describe("the subagent transcript route", () => {
  test("an agent id that is not hex never reaches the filesystem", () => {
    // The alphabet IS the traversal defence, so these must fail to match rather than be sanitised
    // somewhere later. Measured against the live sidecar: 404 and 400 respectively.
    expect(get(`/api/sessions/claude/${SESSION}/agents/..%2F..%2Fetc/transcript`)).toBeUndefined();
    expect(get(`/api/sessions/claude/${SESSION}/agents/not-hex/transcript`)).toBeUndefined();
    expect(get(`/api/sessions/claude/${SESSION}/agents/${AGENT}/output`)).toBeUndefined();
  });

  test("a well-formed id with nothing on disk says so rather than failing", async () => {
    const response = await get(`/api/sessions/claude/${SESSION}/agents/deadbeef/transcript`)!;
    expect(await firstMessage(response)).toEqual({
      kind: "unavailable",
      reason: "no transcript on disk yet",
    });
  });

  test("a fork's transcript opens on its whole run and names where it branched from", async () => {
    await writeTranscripts(AGENT, [
      {
        type: "fork-context-ref",
        agentId: AGENT,
        parentSessionId: SESSION,
        parentLastUuid: "32bdcd26-2861-45d3-973e-dadd87664cf7",
        contextLength: 543,
      },
      {
        type: "assistant",
        uuid: "u1",
        timestamp: "2026-09-09T21:51:20.000Z",
        sessionId: SESSION,
        isSidechain: true,
        agentId: AGENT,
        message: { role: "assistant", content: [{ type: "text", text: "reading the transcript" }] },
      },
    ]);

    const response = await get(`/api/sessions/claude/${SESSION}/agents/${AGENT}/transcript`)!;
    const message = await firstMessage(response);
    expect(message.kind).toBe("snapshot");
    expect(message.agentId).toBe(AGENT);
    expect(message.forkOrigin).toEqual({
      parentSessionId: SESSION,
      parentMessageUuid: "32bdcd26-2861-45d3-973e-dadd87664cf7",
      contextLength: 543,
    });
    expect(Array.isArray(message.events)).toBeTrue();
  });

  test("a subagent that is not a fork simply has no origin", async () => {
    await writeTranscripts("beef01", [
      {
        type: "assistant",
        uuid: "u1",
        timestamp: "2026-09-09T21:51:20.000Z",
        sessionId: SESSION,
        isSidechain: true,
        agentId: "beef01",
        message: { role: "assistant", content: [{ type: "text", text: "an Explore agent" }] },
      },
    ]);
    const response = await get(`/api/sessions/claude/${SESSION}/agents/beef01/transcript`)!;
    const message = await firstMessage(response);
    expect(message.kind).toBe("snapshot");
    expect(message.forkOrigin).toBeUndefined();
  });
});
