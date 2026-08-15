import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalProjectPath,
  isClaudeSessionCandidate,
  projectSummaries,
  registerPiSession,
  resolveClaudeProject,
  sessionSummaries,
  sessionKey,
  stopCatalog,
} from "./transcriptCatalog.ts";
import { PI_AGENT_CAPABILITIES } from "../agents/piAgentBackend.ts";
import type { Session } from "./sources/transcriptTypes.ts";
import { state } from "./transcriptState.ts";
import { claudeAdapter } from "./sources/claudeTranscript.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // Through stopCatalog rather than by hand: it also stops the timers a test that
  // started the catalog would otherwise leave running into the next one.
  await stopCatalog();
  state.sessions.clear();
  state.eventByteOffsets.clear();
  state.indexed.clear();
  state.indexedSizes.clear();
  state.indexReferences.clear();
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

function session(
  source: "claude" | "codex" | "pi",
  sessionId: string,
  project: string,
  lastEventAt: number,
  // What the bounded metadata read put on the record when the session was
  // discovered. The list is built from these and nothing else.
  metadata: Partial<Pick<Session, "title" | "firstPrompt" | "lastTurnClosed">> = {},
): Session {
  return {
    source,
    sessionId,
    project,
    transcriptPath: `/transcripts/${source}/${sessionId}.jsonl`,
    lastEventAt,
    ...metadata,
  };
}

/** Puts a session in the catalog the way a reconcile would, and hands it back. */
function observe(observed: Session): Session {
  state.sessions.set(sessionKey(observed.source, observed.sessionId), observed);
  return observed;
}

describe("transcript catalog identity", () => {
  test("groups Claude and Codex sessions by canonical project path", () => {
    const projects = projectSummaries([
      session("claude", "11111111-1111-1111-1111-111111111111", "/repo", 10),
      session("codex", "22222222-2222-2222-2222-222222222222", "/repo", 20),
    ]);
    expect(projects).toEqual([{
      projectPath: "/repo",
      displayName: "repo",
      sourceCounts: { claude: 1, codex: 1 },
      sessionCount: 2,
      lastEventAt: 20,
    }]);
  });

  test("keeps worktrees separate and never groups by Git origin", () => {
    const projects = projectSummaries([
      session("codex", "11111111-1111-1111-1111-111111111111", "/repo", 10),
      session("codex", "22222222-2222-2222-2222-222222222222", "/repo-worktree", 20),
    ]);
    expect(projects.map((project) => project.projectPath)).toEqual([
      "/repo-worktree",
      "/repo",
    ]);
  });

  test("source is part of session identity", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(sessionKey("claude", id)).not.toBe(sessionKey("codex", id));
  });

  test("accepts only top-level UUID Claude sessions", () => {
    const root = "/claude/projects";
    expect(isClaudeSessionCandidate(
      `${root}/slug/11111111-1111-1111-1111-111111111111.jsonl`,
      root,
    )).toBeTrue();
    expect(isClaudeSessionCandidate(
      `${root}/slug/subagents/11111111-1111-1111-1111-111111111111.jsonl`,
      root,
    )).toBeFalse();
    expect(isClaudeSessionCandidate(
      `${root}/slug/queue-operation.jsonl`,
      root,
    )).toBeFalse();
  });

  test("realpath deduplicates aliases and rejects missing directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-feed-catalog-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const alias = join(root, "alias");
    await mkdir(project);
    await symlink(project, alias);
    expect(await canonicalProjectPath(alias)).toBe(await realpath(project));
    await rm(project, { recursive: true });
    expect(await canonicalProjectPath(project)).toBeNull();
  });

  // The guarantee this whole layer exists for, and the one worth outliving any
  // later refactor of it. Asserted by deleting the transcripts first: if listing a
  // project opened a single body, every row below would fall back to its id.
  test("a project lists with its transcripts deleted, and indexes nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-feed-sessions-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    await mkdir(project);
    const titled = observe(session("claude", "11111111-1111-1111-1111-111111111111", project, 2_000, {
      title: "Refactor the catalog",
      lastTurnClosed: false,
    }));
    observe(session("codex", "22222222-2222-2222-2222-222222222222", project, 1_000, {
      firstPrompt: "fix the flaky test",
    }));
    expect(await Bun.file(titled.transcriptPath).exists()).toBeFalse();

    const summaries = sessionSummaries(project);

    expect(summaries.map((summary) => summary.title)).toEqual([
      "Refactor the catalog",
      "fix the flaky test",
    ]);
    expect(state.eventByteOffsets.size).toBe(0);
    expect(state.indexed.size).toBe(0);
  });

  test("a session with neither a title nor a prompt renders as its id", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    observe(session("claude", id, "/repo", 1_000));
    expect(sessionSummaries("/repo")[0]?.title).toBe(id);
  });

  // Pi records are registered by their backend rather than built by the catalog, so
  // the row is the only place their title is guaranteed to pass through the rule.
  test("a row never renders more title than fits, whoever registered the session", () => {
    const project = "/repo";
    registerPiSession({
      sessionId: "22222222-2222-2222-2222-222222222222",
      projectPath: project,
      transcriptPath: "/transcripts/pi/22222222-2222-2222-2222-222222222222.jsonl",
      title: "w".repeat(600),
      lastEventAt: 3_000,
    });
    const title = sessionSummaries(project)[0]?.title ?? "";
    expect(title).toHaveLength(240);
    expect(title.endsWith("…")).toBeTrue();
  });

  test("newest first, and ties broken so the order does not wobble between reads", () => {
    const project = "/repo";
    observe(session("codex", "bbbbbbbb-2222-2222-2222-222222222222", project, 1_000));
    observe(session("claude", "cccccccc-3333-3333-3333-333333333333", project, 1_000));
    observe(session("claude", "aaaaaaaa-1111-1111-1111-111111111111", project, 5_000));
    expect(sessionSummaries(project).map((summary) => summary.sessionId)).toEqual([
      "aaaaaaaa-1111-1111-1111-111111111111",
      "cccccccc-3333-3333-3333-333333333333",
      "bbbbbbbb-2222-2222-2222-222222222222",
    ]);
  });

  test("an open turn shows live only while the session is recent", () => {
    const project = "/repo";
    const recent = observe(session("claude", "11111111-1111-1111-1111-111111111111", project, Date.now(), {
      lastTurnClosed: false,
    }));
    expect(sessionSummaries(project)[0]?.activity).toBe("live");

    // The same record, unchanged, an hour later. Age is re-checked at read time, so
    // a turn-state stamp that went stale cannot hold a cold session at live.
    recent.lastEventAt = Date.now() - 60 * 60 * 1000;
    expect(sessionSummaries(project)[0]?.activity).not.toBe("live");
  });

  test("uses the live Pi backend as the authority for activity and capabilities", () => {
    const project = "/repo";
    const observed = observe(session("pi", "11111111-1111-1111-1111-111111111111", project, Date.now()));

    const summaries = sessionSummaries(project, (source, sessionId) => ({
      sessionId,
      source,
      projectPath: project,
      title: sessionId,
      lastEventAt: observed.lastEventAt,
      activity: "live",
      capabilities: PI_AGENT_CAPABILITIES,
    }));

    expect(summaries[0]).toMatchObject({
      source: "pi",
      activity: "live",
      capabilities: PI_AGENT_CAPABILITIES,
    });
  });

  test("a Claude transcript reports where it opened and where its shell went, separately", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-feed-cwd-"));
    temporaryDirectories.push(root);
    const opened = join(root, "repo");
    const wandered = join(root, "repo", "backend");
    const transcript = join(root, "11111111-1111-1111-1111-111111111111.jsonl");
    await writeFile(
      transcript,
      `${JSON.stringify({ type: "user", cwd: opened })}\n` +
        `${JSON.stringify({ type: "ai-title", aiTitle: "Renamed project", cwd: wandered })}\n`,
    );

    expect(await claudeAdapter.readHeader(transcript)).toMatchObject({
      cwd: opened,
      recentCwd: wandered,
      title: "Renamed project",
    });
  });

  describe("resolveClaudeProject", () => {
    let root: string;

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "agent-feed-project-"));
      temporaryDirectories.push(root);
    });

    test("a mid-session cd does not move the session to a subdirectory", async () => {
      // The measured failure: honouring the latest cwd split one repo's history across three
      // phantom projects named after its own subfolders.
      const repo = join(root, "chatbot");
      const inside = join(repo, "backend");
      await mkdir(inside, { recursive: true });
      expect(await resolveClaudeProject(repo, inside)).toBe(await realpath(repo));
    });

    test("a cd to the parent does not move it either", async () => {
      const repo = join(root, "chatbot");
      await mkdir(repo);
      expect(await resolveClaudeProject(repo, root)).toBe(await realpath(repo));
    });

    test("a renamed project is found under its new name", async () => {
      // A real rename leaves the opening path GONE. That is the whole discriminator: the previous
      // fixture created both directories, which is what a `cd` looks like, not a rename.
      const gone = join(root, "old-name");
      const renamed = join(root, "new-name");
      await mkdir(renamed);
      expect(await resolveClaudeProject(gone, renamed)).toBe(await realpath(renamed));
    });

    test("a session that never left its directory resolves to it", async () => {
      const repo = join(root, "repo");
      await mkdir(repo);
      expect(await resolveClaudeProject(repo, repo)).toBe(await realpath(repo));
      expect(await resolveClaudeProject(repo, undefined)).toBe(await realpath(repo));
    });

    test("a deleted directory resolves to nothing, as before", async () => {
      const gone = join(root, "deleted");
      expect(await resolveClaudeProject(gone, gone)).toBeNull();
      expect(await resolveClaudeProject(gone, join(root, "also-deleted"))).toBeNull();
    });
  });

  test("a Pi session registered by its backend joins the list it belongs to", () => {
    const project = "/repo";
    observe(session("claude", "11111111-1111-1111-1111-111111111111", project, 1_000));
    registerPiSession({
      sessionId: "22222222-2222-2222-2222-222222222222",
      projectPath: project,
      transcriptPath: "/transcripts/pi/22222222-2222-2222-2222-222222222222.jsonl",
      title: "pi thread",
      lastEventAt: 3_000,
    });
    expect(sessionSummaries(project).map((summary) => summary.title))
      .toEqual(["pi thread", "11111111-1111-1111-1111-111111111111"]);
  });
});
