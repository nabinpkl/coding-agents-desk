import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalProjectPath,
  isClaudeSessionCandidate,
  projectSummaries,
  sessionSummaries,
  sessionKey,
} from "./transcriptCatalog.ts";
import { PI_AGENT_CAPABILITIES } from "../agents/piAgentBackend.ts";
import type { Session } from "./sources/transcriptTypes.ts";
import { state } from "./transcriptState.ts";
import { claudeAdapter } from "./sources/claudeTranscript.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
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
): Session {
  return {
    source,
    sessionId,
    project,
    transcriptPath: `/transcripts/${source}/${sessionId}.jsonl`,
    lastEventAt,
  };
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

  test("selected-project summaries do bounded parsing without retaining an event index", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-feed-sessions-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const transcript = join(root, "11111111-1111-1111-1111-111111111111.jsonl");
    await mkdir(project);
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: "user",
        cwd: project,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "bounded session title" },
      })}\n`,
    );
    const observed = session(
      "claude",
      "11111111-1111-1111-1111-111111111111",
      project,
      Date.now(),
    );
    observed.transcriptPath = transcript;
    state.sessions.set(sessionKey(observed.source, observed.sessionId), observed);

    const summaries = await sessionSummaries(project);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.title).toBe("bounded session title");
    expect(state.eventByteOffsets.size).toBe(0);
    expect(state.indexed.size).toBe(0);
  });

  test("uses the live Pi backend as the authority for activity and capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-feed-pi-summary-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const transcript = join(root, "11111111-1111-1111-1111-111111111111.jsonl");
    await mkdir(project);
    await writeFile(transcript, `${JSON.stringify({ type: "session" })}\n`);
    const observed = session(
      "pi",
      "11111111-1111-1111-1111-111111111111",
      project,
      Date.now(),
    );
    observed.transcriptPath = transcript;
    state.sessions.set(sessionKey(observed.source, observed.sessionId), observed);

    const summaries = await sessionSummaries(project, (source, sessionId) => ({
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

  test("a changed Claude transcript reports its latest direct cwd and title evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-feed-rename-"));
    temporaryDirectories.push(root);
    const oldProject = join(root, "foo");
    const newProject = join(root, "bar");
    const transcript = join(root, "11111111-1111-1111-1111-111111111111.jsonl");
    await mkdir(oldProject);
    await mkdir(newProject);
    await writeFile(
      transcript,
      `${JSON.stringify({ type: "user", cwd: oldProject })}\n` +
        `${JSON.stringify({
          type: "ai-title",
          aiTitle: "Renamed project",
          cwd: newProject,
        })}\n`,
    );

    expect(await claudeAdapter.readHeader(transcript)).toMatchObject({
      cwd: newProject,
      title: "Renamed project",
    });
  });
});
