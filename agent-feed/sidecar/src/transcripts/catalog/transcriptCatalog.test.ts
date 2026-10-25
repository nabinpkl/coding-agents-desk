import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtemp, mkdir, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonicalProjectPath,
  refreshCodexRollout,
  isClaudeSessionCandidate,
  projectSummaries,
  registerPiSession,
  resolveClaudeProject,
  sessionSummaries,
  sessionKey,
  subscribeCatalog,
  stopCatalog,
} from "@/transcripts/catalog/transcriptCatalog";
import { reconcileClaude, refreshClaudeSession } from "@/transcripts/catalog/claudeCatalog";
import { config } from "@/config/config";
import { PI_AGENT_CAPABILITIES } from "@/agents/piAgentBackend";
import type { Session } from "@/transcripts/transcriptTypes";
import { state } from "@/transcripts/transcriptState";
import { BROADCAST_COALESCE_MS } from "@/transcripts/catalog/catalogState";
import { claudeAdapter } from "@/transcripts/claude/claudeTranscript";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  // Through stopCatalog rather than by hand: it also stops the timers a test that
  // started the catalog would otherwise leave running into the next one.
  await stopCatalog();
  state.sessions.clear();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function session(
  source: "claude" | "codex" | "pi" | "opencode",
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
    expect(projects).toEqual([
      {
        projectPath: "/repo",
        displayName: "repo",
        sourceCounts: { claude: 1, codex: 1, opencode: 0 },
        sessionCount: 2,
        lastEventAt: 20,
      },
    ]);
  });

  test("keeps worktrees separate and never groups by Git origin", () => {
    const projects = projectSummaries([
      session("codex", "11111111-1111-1111-1111-111111111111", "/repo", 10),
      session("codex", "22222222-2222-2222-2222-222222222222", "/repo-worktree", 20),
    ]);
    expect(projects.map((project) => project.projectPath)).toEqual(["/repo-worktree", "/repo"]);
  });

  test("source is part of session identity", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    expect(sessionKey("claude", id)).not.toBe(sessionKey("codex", id));
  });

  test("accepts only top-level UUID Claude sessions", () => {
    const root = "/claude/projects";
    expect(isClaudeSessionCandidate(`${root}/slug/11111111-1111-1111-1111-111111111111.jsonl`, root)).toBeTrue();
    expect(
      isClaudeSessionCandidate(`${root}/slug/subagents/11111111-1111-1111-1111-111111111111.jsonl`, root),
    ).toBeFalse();
    expect(isClaudeSessionCandidate(`${root}/slug/queue-operation.jsonl`, root)).toBeFalse();
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
    const titled = observe(
      session("claude", "11111111-1111-1111-1111-111111111111", project, 2_000, {
        title: "Refactor the catalog",
        lastTurnClosed: false,
      }),
    );
    observe(
      session("codex", "22222222-2222-2222-2222-222222222222", project, 1_000, {
        firstPrompt: "fix the flaky test",
      }),
    );
    const transcriptPath = titled.transcriptPath;
    if (!transcriptPath) throw new Error("test session lost its transcript path");
    expect(await Bun.file(transcriptPath).exists()).toBeFalse();

    const summaries = sessionSummaries(project);

    expect(summaries.map((summary) => summary.title)).toEqual(["Refactor the catalog", "fix the flaky test"]);
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
    const recent = observe(
      session("claude", "11111111-1111-1111-1111-111111111111", project, Date.now(), {
        lastTurnClosed: false,
      }),
    );
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
      recentCwds: [wandered, opened],
      title: "Renamed project",
    });
  });

  test("a transcript that stops reading keeps its session until the file is gone", async () => {
    // The vanish this guards: `refreshClaudeSession` fires on every write a running agent makes,
    // and a header that comes back with nothing is a read this reader could not use rather than a
    // session that ended. Answering it with a delete took a working session off the panel
    // mid-turn, over and over, for as long as its writes were larger than the tail window.
    const projects = await mkdtemp(join(tmpdir(), "agent-feed-projects-"));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "agent-feed-repo-")));
    temporaryDirectories.push(projects, repo);
    const slug = join(projects, "-repo");
    await mkdir(slug, { recursive: true });
    const sessionId = "33333333-3333-3333-3333-333333333333";
    const key = sessionKey("claude", sessionId);
    const transcript = join(slug, `${sessionId}.jsonl`);
    const mutableConfig = config as unknown as { claudeProjectsDirectory: string };
    const previousProjects = config.claudeProjectsDirectory;
    mutableConfig.claudeProjectsDirectory = projects;
    try {
      await writeFile(transcript, `${JSON.stringify({ type: "user", cwd: repo })}\n`);
      await refreshClaudeSession(transcript);
      expect(state.sessions.get(key)?.project).toBe(repo);

      await writeFile(transcript, `${JSON.stringify({ type: "system", note: "no cwd" })}\n`);
      await refreshClaudeSession(transcript);
      expect(state.sessions.get(key)?.project).toBe(repo);
      // And the sweep does not undo it: it deletes by what is on disk, not by what read.
      await reconcileClaude();
      expect(state.sessions.get(key)?.project).toBe(repo);

      // A transcript that reads fine and names a directory that is gone is the other answer,
      // and it still drops: that is news about the session rather than about the read.
      const removed = join(repo, "worktree");
      await mkdir(removed, { recursive: true });
      await writeFile(transcript, `${JSON.stringify({ type: "user", cwd: removed })}\n`);
      await refreshClaudeSession(transcript);
      expect(state.sessions.get(key)?.project).toBe(await realpath(removed));
      await rm(removed, { recursive: true });
      await refreshClaudeSession(transcript);
      expect(state.sessions.has(key)).toBe(false);

      await writeFile(transcript, `${JSON.stringify({ type: "user", cwd: repo })}\n`);
      await refreshClaudeSession(transcript);
      await rm(transcript);
      await refreshClaudeSession(transcript);
      expect(state.sessions.has(key)).toBe(false);
    } finally {
      mutableConfig.claudeProjectsDirectory = previousProjects;
    }
  });

  test("a Claude session is as recent as its newest record, not its file's mtime", async () => {
    // Measured 2026-10-11: idle CLIs touched transcripts last written on Oct 3, and the mtime
    // stamp moved six sessions to "03:01 today" and their projects to the top of the list.
    const projects = await mkdtemp(join(tmpdir(), "agent-feed-projects-"));
    const repo = await realpath(await mkdtemp(join(tmpdir(), "agent-feed-repo-")));
    temporaryDirectories.push(projects, repo);
    await mkdir(join(projects, "-repo"), { recursive: true });
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const transcript = join(projects, "-repo", `${sessionId}.jsonl`);
    const mutableConfig = config as unknown as { claudeProjectsDirectory: string };
    const previousProjects = config.claudeProjectsDirectory;
    mutableConfig.claudeProjectsDirectory = projects;
    try {
      await writeFile(
        transcript,
        `${JSON.stringify({ type: "user", cwd: repo, timestamp: "2026-10-03T21:58:00.000Z" })}\n` +
          `${JSON.stringify({ type: "system", cwd: repo, timestamp: "2026-10-03T21:58:56.111Z" })}\n` +
          // The re-emitted metadata the CLI writes carries no timestamp, so it moves nothing.
          `${JSON.stringify({ type: "permission-mode", permissionMode: "auto" })}\n`,
      );
      await utimes(transcript, new Date(), new Date());
      await refreshClaudeSession(transcript);
      expect(state.sessions.get(sessionKey("claude", sessionId))?.lastEventAt).toBe(
        Date.parse("2026-10-03T21:58:56.111Z"),
      );
    } finally {
      mutableConfig.claudeProjectsDirectory = previousProjects;
    }
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
      expect(await resolveClaudeProject(repo, [inside])).toBe(await realpath(repo));
    });

    test("a cd to the parent does not move it either", async () => {
      const repo = join(root, "chatbot");
      await mkdir(repo);
      expect(await resolveClaudeProject(repo, [root])).toBe(await realpath(repo));
    });

    test("a renamed project is found under its new name", async () => {
      // A real rename leaves the opening path GONE. That is the whole discriminator: the previous
      // fixture created both directories, which is what a `cd` looks like, not a rename.
      const gone = join(root, "old-name");
      const renamed = join(root, "new-name");
      await mkdir(renamed);
      expect(await resolveClaudeProject(gone, [renamed])).toBe(await realpath(renamed));
    });

    test("a session that never left its directory resolves to it", async () => {
      const repo = join(root, "repo");
      await mkdir(repo);
      expect(await resolveClaudeProject(repo, [repo])).toBe(await realpath(repo));
      expect(await resolveClaudeProject(repo, undefined)).toBe(await realpath(repo));
    });

    test("a deleted directory resolves to nothing, as before", async () => {
      const gone = join(root, "deleted");
      expect(await resolveClaudeProject(gone, [gone])).toBeNull();
      expect(await resolveClaudeProject(gone, [join(root, "also-deleted")])).toBeNull();
    });

    test("a newest path that is gone too falls back to the newest one still there", async () => {
      // The measured case: opened in a worktree since removed, last ran in a scratch directory
      // since deleted, and had worked in the repository before that.
      const worktree = join(root, "repo", ".worktrees", "arena");
      const repo = join(root, "repo");
      const scratch = join(root, "scratch", "probe");
      await mkdir(repo);
      expect(await resolveClaudeProject(worktree, [scratch, repo, worktree])).toBe(await realpath(repo));
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
    expect(sessionSummaries(project).map((summary) => summary.title)).toEqual([
      "pi thread",
      "11111111-1111-1111-1111-111111111111",
    ]);
  });
});

describe("codex rollout refresh", () => {
  const SESSION = "33333333-3333-3333-3333-333333333333";

  /** A rollout file named the way Codex names them, with a session already known. */
  async function knownRollout(
    metadata: Partial<Pick<Session, "title" | "lastTurnClosed">> = {},
  ): Promise<{ path: string; record: Session }> {
    const root = await mkdtemp(join(tmpdir(), "codex-rollout-"));
    temporaryDirectories.push(root);
    const path = join(root, `rollout-2026-08-22T01-02-03-${SESSION}.jsonl`);
    await writeFile(path, '{"timestamp":"2026-08-22T01:02:03.000Z","type":"turn_context"}\n');
    const record: Session = {
      source: "codex",
      sessionId: SESSION,
      project: "/repo",
      transcriptPath: path,
      lastEventAt: 1,
      title: "from the database",
      gitBranch: "main",
      ...metadata,
    };
    observe(record);
    return { path, record };
  }

  // The point of the whole path: a line appended to a live session must not cost a
  // re-read of every thread Codex has ever had. Proven by what is NOT re-read --
  // the title and branch only exist in the state database, so a record that still
  // carries them was refreshed from the file alone.
  test("advances a known session from its file without re-reading the database", async () => {
    const { path } = await knownRollout();

    await refreshCodexRollout(path);

    const refreshed = state.sessions.get(sessionKey("codex", SESSION));
    expect(refreshed?.lastEventAt).toBeGreaterThan(1);
    expect(refreshed?.title).toBe("from the database");
    expect(refreshed?.gitBranch).toBe("main");
  });

  // These two run on fake time: the per-file paths coalesce their broadcast on a timer, and the
  // test moves the clock past it rather than waiting that long for real.
  test("tells the catalog's subscribers", async () => {
    const { path } = await knownRollout();
    jest.useFakeTimers();
    let broadcasts = 0;
    const unsubscribe = subscribeCatalog(() => {
      broadcasts += 1;
    });
    try {
      await refreshCodexRollout(path);
      jest.advanceTimersByTime(BROADCAST_COALESCE_MS);
      expect(broadcasts).toBe(1);
    } finally {
      unsubscribe();
      jest.useRealTimers();
    }
  });

  test("says nothing when the file moved but the record did not change", async () => {
    const { path } = await knownRollout();
    jest.useFakeTimers();
    try {
      await refreshCodexRollout(path);
      // Past the first refresh's own coalesce window, so its broadcast is not counted
      // against the second one.
      jest.advanceTimersByTime(BROADCAST_COALESCE_MS);
      const settled = { ...state.sessions.get(sessionKey("codex", SESSION))! };

      let broadcasts = 0;
      const unsubscribe = subscribeCatalog(() => {
        broadcasts += 1;
      });
      try {
        await refreshCodexRollout(path);
        jest.advanceTimersByTime(BROADCAST_COALESCE_MS);
        expect(broadcasts).toBe(0);
        expect(state.sessions.get(sessionKey("codex", SESSION))).toEqual(settled);
      } finally {
        unsubscribe();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  // A rollout with no record is a thread the catalog has not seen, and the row that
  // would describe it lives in the database. This path must not invent one.
  test("leaves an unknown session to the full pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-rollout-"));
    temporaryDirectories.push(root);
    const path = join(root, `rollout-2026-08-22T01-02-03-${SESSION}.jsonl`);
    await writeFile(path, "{}\n");

    await refreshCodexRollout(path);

    expect(state.sessions.has(sessionKey("codex", SESSION))).toBe(false);
  });

  // Archiving moves the file. Refreshing the record in place would leave the catalog
  // pointing at a path that is about to stop existing.
  test("leaves a record whose transcript lives somewhere else alone", async () => {
    const { path, record } = await knownRollout();
    record.transcriptPath = "/somewhere/else.jsonl";

    await refreshCodexRollout(path);

    expect(state.sessions.get(sessionKey("codex", SESSION))?.lastEventAt).toBe(1);
  });

  test("ignores a file that is not a rollout", async () => {
    const { record } = await knownRollout();
    await refreshCodexRollout("/tmp/notes.jsonl");
    expect(record.lastEventAt).toBe(1);
  });
});
