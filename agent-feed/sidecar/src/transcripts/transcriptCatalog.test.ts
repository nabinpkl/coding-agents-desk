import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFile,
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
  probeSession,
  projectSummaries,
  registerPiSession,
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
  // Through stopCatalog rather than by hand: the probes and the memoized summaries
  // are derived state that outlives a `state.sessions.clear()`, and two tests using
  // the same session id would otherwise be answered from each other's readings.
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

  test("prefers a custom title set beyond the bounded probe window", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-feed-custom-title-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const transcript = join(root, "11111111-1111-1111-1111-111111111111.jsonl");
    await mkdir(project);
    // The ai-title and custom-title lines sit in the MIDDLE of a file large
    // enough that the bounded head/tail probe never sees them (matching the
    // plutus-agent-eval transcript where they appear tens of KB in). The full
    // title scan must find them and prefer the user-set custom title.
    const headPad = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "x".repeat(40000) } });
    const aiTitle = JSON.stringify({ type: "ai-title", aiTitle: "Auto derived title", cwd: project });
    const customTitle = JSON.stringify({ type: "custom-title", customTitle: "Plutus Agent Eval", cwd: project });
    const tailPad = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "y".repeat(40000) } });
    await writeFile(transcript, `${headPad}\n${aiTitle}\n${customTitle}\n${tailPad}\n`);
    const observed = session("claude", "11111111-1111-1111-1111-111111111111", project, Date.now());
    observed.transcriptPath = transcript;
    state.sessions.set(sessionKey(observed.source, observed.sessionId), observed);

    const summaries = await sessionSummaries(project);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.title).toBe("Plutus Agent Eval");
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

  test("a session is re-read only over the bytes it gained, and not at all when unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-feed-probe-"));
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
        message: { role: "user", content: "first prompt" },
      })}\n`,
    );
    const observed = session(
      "claude",
      "11111111-1111-1111-1111-111111111111",
      project,
      1_000,
    );
    observed.transcriptPath = transcript;
    state.sessions.set(sessionKey(observed.source, observed.sessionId), observed);

    expect((await probeSession(observed)).title).toBe("first prompt");

    // The catalog stamp moved, so the probe extends over the appended line. It keeps
    // what it already parsed: the title below is only reachable from the new bytes,
    // and the activity stamp only from the old ones.
    await appendFile(
      transcript,
      `${JSON.stringify({ type: "custom-title", customTitle: "Named later", cwd: project })}\n`,
    );
    observed.lastEventAt = 2_000;
    expect((await probeSession(observed)).title).toBe("Named later");

    // The file is gone, and the stamp has not moved. A probe that re-read the
    // transcript on every emission would fail here and fall back to the session id.
    await rm(transcript);
    expect((await probeSession(observed)).title).toBe("Named later");
  });

  test("one project's session list is computed once per catalog change, however many viewers ask", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-feed-fanout-"));
    temporaryDirectories.push(root);
    const project = join(root, "project");
    const transcript = join(root, "11111111-1111-1111-1111-111111111111.jsonl");
    await mkdir(project);
    await writeFile(transcript, `${JSON.stringify({ type: "user", cwd: project })}\n`);
    const observed = session(
      "claude",
      "11111111-1111-1111-1111-111111111111",
      project,
      1_000,
    );
    observed.transcriptPath = transcript;
    state.sessions.set(sessionKey(observed.source, observed.sessionId), observed);

    // Two agent windows expanded on the same project. The second joins the first's
    // work rather than starting a second pass over the same files, and it joins the
    // promise, not the result, so arriving mid-read counts as joining.
    const first = sessionSummaries(project);
    expect(sessionSummaries(project)).toBe(first);
    expect(await first).toHaveLength(1);
    expect(sessionSummaries(project)).toBe(first);

    // A catalog change is what makes the answer stale, and nothing else does.
    registerPiSession({
      sessionId: "22222222-2222-2222-2222-222222222222",
      projectPath: project,
      transcriptPath: join(root, "22222222-2222-2222-2222-222222222222.jsonl"),
      title: "pi thread",
      lastEventAt: 3_000,
    });
    const afterChange = sessionSummaries(project);
    expect(afterChange).not.toBe(first);
    expect(await afterChange).toHaveLength(2);
  });
});
