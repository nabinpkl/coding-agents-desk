// Arena runs: one prompt fanned out to contestants, and the facts each left behind.
//
// A run is recording-only. The arena never scores and never ranks; it records how long each
// contestant took, which files its tools touched, what it spent, and what diff it left, and the
// panel shows those facts. Judgment is a reader's act, and a reader judges from the session
// itself: a contestant's session is an ordinary catalog session that every existing session
// surface already renders, so the arena adds the grouping and the facts, not a new session viewer.
// A run may have a manager, which is the same thing again: an ordinary session, briefed with the
// facts and with this API, that the reader can ask to plan the lanes (how many, which harness, which
// model), to prompt them, or for a verdict. What it decides is an API call anyone could have made;
// a verdict is its answer, never a score the arena keeps.
//
// Statuses travel, facts wait. `gitDiff` and the file lists scale with the work a prompt asked
// for, so they ride the detail route on demand rather than every status push, the same split the
// transcript itself keeps between its list and its body.

/**
 * The harnesses an arena run can drive a contestant with. A source the arena cannot drive is
 * refused with 400 naming it, rather than queued for a driver that does not exist.
 */
export type ArenaContestantSource = "opencode" | "claude";

/**
 * How a run drives its contestants.
 *
 * `terminals` starts each contestant as an ordinary interactive session in its own tmux pane --
 * the same sessions a canvas card shows -- waits until every one of them can take a prompt, and
 * types the one prompt into each. `headless` drives each harness with no pane at all (`claude
 * --print`, and the opencode serve's API alone), which is what a machine without tmux can run.
 * The facts the arena records are the same in both; only how the turn is driven differs.
 */
export type ArenaRunMode = "terminals" | "headless";

/**
 * Which side of the prompt a lane takes. A `for` lane does what the prompt asks, as every lane
 * did before stances. An `against` lane is given the same prompt and argues that it should not be
 * done, or not this way: it is told so with every prompt, cannot edit a file, and never sees
 * another lane's work, so what it argues against is the idea, not one lane's attempt at it.
 */
export type ArenaLaneStance = "for" | "against";

/**
 * Where a contestant stands. `starting` and `ready` are the terminals mode's own: the pane is up
 * and its harness is still loading (or waiting on the reader, say at a folder-trust question), and
 * then it can take the prompt and is waiting for the rest of the run to be able to as well.
 */
export type ArenaContestantStatus = "preparing" | "starting" | "ready" | "running" | "closed" | "failed";

/** Every status in which a contestant is still somebody's live work, not a settled fact. */
export const ARENA_LIVE_STATUSES: readonly ArenaContestantStatus[] = ["preparing", "starting", "ready", "running"];

/** One contestant of a run, as a status surface needs it: identity and where it stands. */
export interface ArenaContestantSummary {
  contestantId: string;
  source: ArenaContestantSource;
  /**
   * The model the lane was asked to run, as its harness spells it (`sonnet`, `claude-opus-5-5`;
   * `provider/model` for opencode), or null for the harness's own default.
   */
  model: string | null;
  stance: ArenaLaneStance;
  /** The session this contestant is, once its backend has made one; null until then. */
  sessionId: string | null;
  worktreePath: string;
  /** The tmux session the contestant runs in, in the terminals mode; null in headless. */
  tmuxSession: string | null;
  status: ArenaContestantStatus;
  startedAt: number | null;
  closedAt: number | null;
  /**
   * Wall time from the contestant's turn opening to its turn closing. A rough fact, not a
   * benchmark: headless, the turn opens when the session exists, the send landing milliseconds
   * after; in the terminals mode it opens when the prompt is typed, so a harness's load time and
   * a reader answering a startup question are not on the clock. Machine load rides it either way.
   */
  durationMs: number | null;
  /** Why a contestant failed, one line; null otherwise. */
  error: string | null;
}

/** A run, as a list or a stream needs it: what was asked and where each contestant stands. */
export interface ArenaRunSummary {
  runId: string;
  /**
   * What the reader calls the run, unique on the machine: "arena run 3" unless they named it. Its
   * folder in the arena home is named after it, and holds the contestants' worktrees.
   */
  name: string;
  /** The run's folder in the arena home, holding its contestants' worktrees and its manager's folder. */
  folder: string;
  /**
   * The latest prompt every lane was given. A run never ends: once every contestant has settled,
   * the next prompt goes to each of them in the session it already has. Empty while a terminals
   * run has its lanes open and waits for its first.
   */
  prompt: string;
  /** How many prompts the run has been given: 0 while it waits for its first. */
  round: number;
  repoPath: string;
  /** Whether the arena made `repoPath` for this run, as the run's own folder, rather than the run naming one. */
  repoCreated: boolean;
  baseRef: string;
  mode: ArenaRunMode;
  createdAt: number;
  contestants: ArenaContestantSummary[];
  /** The run's manager, or null for a run that asked for none. */
  manager: ArenaManagerSummary | null;
}

/**
 * Where a manager stands: its pane on the way up, open for the reader to ask, or failed to start.
 * A manager takes no turn the arena drives, so it has no running or closed of its own.
 */
export type ArenaManagerStatus = "starting" | "open" | "failed";

/**
 * A run's manager: an ordinary interactive session in a tmux pane, working in the run's `manager`
 * folder. The arena keeps a brief there -- the prompt, every contestant's facts, each one's
 * transcript and diff as files, and how to call this API for its run -- rewritten whenever the run
 * changes, and never prompts the manager itself: the reader does, to have it plan and start the
 * lanes, prompt them, or compare what they did. Its harness lets it edit no file; its calls to this
 * API are shell commands under the harness's own permission mode.
 */
export interface ArenaManagerSummary {
  source: ArenaContestantSource;
  status: ArenaManagerStatus;
  /** The manager's working folder, `<run folder>/manager`, which holds its brief. */
  folder: string;
  sessionId: string | null;
  tmuxSession: string | null;
  /** Why the manager failed to start, one line; null otherwise. */
  error: string | null;
}

/** One lane a run is asked for: the harness that drives it, and optionally the model it runs. */
export interface ArenaLaneRequest {
  source: ArenaContestantSource;
  /** As the harness spells it; `provider/model` for opencode. Absent or null for its default. */
  model?: string | null;
  /** Absent for `for`. */
  stance?: ArenaLaneStance;
}

/** Facts a contestant left behind, read on demand. */
export interface ArenaContestantDetail extends ArenaContestantSummary {
  /** Context occupancy as of the contestant's close, or null when its backend reported none. */
  contextTokens: number | null;
  /** The session's reported spend in USD, or null when its backend reported none. Cost math
   * belongs to the side that prices; the arena repeats the figure, it never computes one. */
  costUsd: number | null;
  /** Paths the contestant's read-like tools named, in first-mention order, deduplicated. */
  filesRead: string[];
  /** Paths the contestant's write-like tools named, in first-mention order, deduplicated. */
  filesWritten: string[];
  /**
   * Every place outside its own worktree its tools reached, read off its events at close, in
   * first-mention order. Contestants run as plain agents, so nothing stops a reach; this is what
   * says one happened, and whether it was into a rival's worktree.
   */
  outsideReached: ArenaOutsideReach[];
  /**
   * The text its latest turn ended with: what it said after its last tool call, or all it said in
   * the turn when it said nothing after one. Null before its first turn closes. What a pass sends.
   */
  answer: string | null;
  /** `git diff <baseRef>` in the contestant's worktree at close, bounded in size. Null while
   * the contestant runs, and for one that failed before its turn closed. Untracked files a
   * contestant left are not in it; `filesWritten` is where they are still named. */
  gitDiff: string | null;
}

/**
 * One place outside its own worktree a contestant's tools reached.
 *
 * `how` is the kind of tool that named it: a file tool's read or write, a search tool's path, or a
 * path written into a shell command. The last is read from the command's text, so it says the
 * command named the path, not that the shell opened it.
 */
export interface ArenaOutsideReach {
  /** Absolute, as resolved against the contestant's worktree. */
  path: string;
  how: "read" | "write" | "search" | "shell";
  /** The contestant whose worktree the path is in, or null for anywhere else. */
  rival: string | null;
}

export interface ArenaRunDetail extends ArenaRunSummary {
  contestants: ArenaContestantDetail[];
}

/**
 * `POST /api/arena/runs`. Each contestant names the harness that drives it, so one run can
 * duel two of the same harness or one of each.
 */
export interface ArenaCreateRunRequest {
  /**
   * The one prompt. A terminals run may leave it empty: that opens its lanes, each harness comes
   * up in its pane, and the prompt follows with `POST /api/arena/runs/:id/prompt` once the reader
   * has it. A headless run has no lanes to open first, so it is refused without one.
   */
  prompt: string;
  /** The run's name; the next free "arena run N" when absent or empty. */
  name?: string;
  /**
   * Absolute path of the git repository the contestants get worktrees of. Absent or empty, the
   * run gets a new repository of its own: its folder in the arena home, with one empty commit.
   */
  repoPath?: string;
  /** The ref every contestant's worktree starts at; "HEAD" when absent. */
  baseRef?: string;
  /** How the contestants are driven; the sidecar picks `terminals` when it has tmux, otherwise `headless`. */
  mode?: ArenaRunMode;
  /**
   * The lanes. A terminals run with a manager and no prompt may name none: its manager adds them
   * (`POST /api/arena/runs/:id/contestants`) once the reader has asked it to plan them.
   */
  contestants: ArenaLaneRequest[];
  /**
   * The harness the run's manager runs in, or null (or absent) for no manager. A manager lives in
   * a terminal, so only a terminals run may ask for one.
   */
  manager?: ArenaContestantSource | null;
}

/**
 * `POST /api/arena/runs/:id/contestants`: more lanes for a terminals run that has not had its first
 * prompt yet. They open beside the others and wait for that prompt with them.
 */
export interface ArenaAddLanesRequest {
  contestants: ArenaLaneRequest[];
}

/**
 * `POST /api/arena/runs/:id/pass`: one lane's latest answer, sent to a lane of the other stance as
 * its next turn. Against gets a for lane's answer to critique; for gets an against lane's critique
 * to weigh. Taken once every lane of the run has settled.
 */
export interface ArenaPassRequest {
  /** The lane whose answer is passed, by its contestant id (`c1`). */
  from: string;
  /** The lane it is passed to; its stance must differ from `from`'s. */
  to: string;
}

/** `POST /api/arena/runs/:id/prompt`: the prompt a terminals run's open lanes wait for. Given once. */
export interface ArenaPromptRequest {
  prompt: string;
}

/** `GET /api/arena/new-run`: what a run asked for with nothing filled in would get on this machine. */
export interface ArenaNewRunDefaults {
  /** The modes this machine can run, the default first. */
  modes: ArenaRunMode[];
  /** The absolute folder every run's own folder is made in. */
  arenaHome: string;
  /** The name a run given none would get now. */
  nextName: string;
}

/** One message of the arena status stream: the whole run list, pushed on every change. */
export interface ArenaRunsStreamMessage {
  type: "runs";
  runs: ArenaRunSummary[];
}
