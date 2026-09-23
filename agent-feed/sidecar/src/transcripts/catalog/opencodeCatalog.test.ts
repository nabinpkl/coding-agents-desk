import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeClient, SessionV2Info } from "@opencode-ai/sdk/v2/client";
import { state } from "@/transcripts/transcriptState";
import { sessionKey } from "@/transcripts/catalog/catalogState";
import {
  reconcileOpencode,
  registerOpencodeSession,
  resolveOpencodeSession,
} from "@/transcripts/catalog/opencodeCatalog";

afterEach(async () => {
  for (const key of [...state.sessions.keys()]) {
    if (key.startsWith("opencode:")) state.sessions.delete(key);
  }
});

function serveSession(id: string, directory: string, updated: number): SessionV2Info {
  return {
    id,
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated },
    title: `Title ${id}`,
    location: { directory },
  };
}

function fakeClient(sessions: SessionV2Info[]) {
  return {
    v2: {
      session: {
        list: async () => ({ data: { data: sessions } }),
      },
    },
  } as unknown as OpencodeClient;
}

test("reconcile lists serve sessions under their canonical directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-catalog-"));
  const project = join(root, "repo");
  await mkdir(project);
  try {
    await reconcileOpencode(fakeClient([serveSession("ses-1", project, 500)]));
    const record = state.sessions.get(sessionKey("opencode", "ses-1"));
    const { realpath } = await import("node:fs/promises");
    expect(record?.sessionId).toBe("ses-1");
    expect(record?.source).toBe("opencode");
    expect(record?.project).toBe(await realpath(project));
    expect(record?.title).toBe("Title ses-1");
    expect(record?.lastEventAt).toBe(500);
    // No transcript on a backend-owned record: readers must use the backend.
    expect(record?.transcriptPath).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconcile prunes sessions the serve no longer lists", async () => {
  registerOpencodeSession({ sessionId: "ses-gone", projectPath: "/repo" });
  expect(state.sessions.has(sessionKey("opencode", "ses-gone"))).toBe(true);
  await reconcileOpencode(fakeClient([]));
  expect(state.sessions.has(sessionKey("opencode", "ses-gone"))).toBe(false);
});

test("a created session registers immediately and resolves for the backend", async () => {
  registerOpencodeSession({ sessionId: "ses-new", projectPath: "/repo" });
  expect(resolveOpencodeSession("ses-new")).toEqual({ sessionId: "ses-new", projectPath: "/repo" });
  expect(resolveOpencodeSession("ses-missing")).toBeUndefined();
});

test("no password leaves the source empty rather than failing the catalog", async () => {
  await reconcileOpencode(null);
  expect([...state.sessions.keys()].filter((key) => key.startsWith("opencode:"))).toEqual([]);
});
