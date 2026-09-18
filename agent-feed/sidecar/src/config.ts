import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runtimePaths } from "@repo/tools/runtime-paths.mjs";
import {
  booleanEnvironment,
  directoryEnvironment,
  integerEnvironment,
  urlEnvironment,
} from "@/configEnvironment";
import { contextWindowEnvironment, contextWindowIn } from "@/contextWindows";
import { tmuxBinary, yabaiBinary } from "@/configBinaries";

const userHomeDirectory = homedir();
const staleThresholdMs = integerEnvironment(
  "AGENT_FEED_STALE_THRESHOLD_MS",
  2 * 60 * 60 * 1000,
  60 * 1000,
  7 * 24 * 60 * 60 * 1000,
);
const readyThresholdMs = integerEnvironment(
  "AGENT_FEED_READY_THRESHOLD_MS",
  5 * 60 * 1000,
  1000,
  60 * 60 * 1000,
);

if (readyThresholdMs >= staleThresholdMs) {
  throw new Error("AGENT_FEED_READY_THRESHOLD_MS must be less than AGENT_FEED_STALE_THRESHOLD_MS");
}

// The turn summarizer's model credential, taken out of the environment before Pi constructs tools
// whose child processes inherit process.env. Pi is handed this key directly
// (`ModelRuntimeAuthOverrides`), so nothing needs it in `process.env`, and leaving it there would
// put a paid API key in the environment of every tool subprocess the agent backends spawn.
const summaryApiKey = process.env.AGENT_FEED_SUMMARY_API_KEY?.trim() || null;
delete process.env.AGENT_FEED_SUMMARY_API_KEY;


export const config = {
  host: process.env.AGENT_FEED_HOST ?? "127.0.0.1",
  port: integerEnvironment("AGENT_FEED_PORT", 7682, 1, 65_535),
  claudeProjectsDirectory: directoryEnvironment(
    "AGENT_FEED_CLAUDE_PROJECTS_DIR",
    join(userHomeDirectory, ".claude", "projects"),
  ),
  // The harness's own top-level config, `~/.claude.json`.
  //
  // Read for one field, `cachedUsageUtilization`, which is the only place Claude's rate limits are
  // written to disk: the five-hour and seven-day meters the CLI feeds to a statusline through
  // `.rate_limits.five_hour.used_percentage`. It is a CACHE the CLI refreshes on its own schedule
  // rather than a per-request stamp -- measured 45 hours stale on this machine while sessions ran
  // throughout -- which is why `UsageQuota` carries `sampledAt` and the panel shows the age.
  claudeConfigPath: resolve(
    process.env.AGENT_FEED_CLAUDE_CONFIG_PATH?.trim()
      || join(userHomeDirectory, ".claude.json"),
  ),
  // The harness's own pid -> session registry. Each `<pid>.json` names the session a
  // running Claude process is serving, which is the only bridge between a transcript on
  // disk and the live process running it: the one that owns its background shells
  // (ADR-0099) and publishes the inbox a turn is delivered to (ADR-0107). The auth keys
  // for those inboxes sit in the same directory.
  claudeSessionsDirectory: directoryEnvironment(
    "AGENT_FEED_CLAUDE_SESSIONS_DIR",
    join(userHomeDirectory, ".claude", "sessions"),
  ),
  // Where the harness parks a background task's stdout capture, as
  // `<root>/<project-slug>/<session-id>/tasks/<task-id>.output`.
  //
  // Read as a FENCE, never as a path builder. A running task's output path comes from the
  // kernel (the task shell's own fd 1) and a finished one's from the harness's tool_result
  // text; this value only answers "is that path where it should be" before we open it.
  //
  // `/tmp` rather than `/private/tmp`, which is where this pointed and is a macOS spelling: on
  // Linux there is no `/private` at all and the captures are at `/tmp/claude-<uid>`, so a peer
  // fenced every one of its own tasks out and showed none. On a Mac the two name one directory
  // through a symlink, and `isInsideTaskRoot` accepts both spellings rather than trusting this
  // one -- measured on this machine, transcripts carry 23,540 of the `/private` spelling and 354
  // of the bare one, and the bare ones were being refused here too.
  claudeTaskRoot: directoryEnvironment(
    "AGENT_FEED_CLAUDE_TASK_ROOT",
    `/tmp/claude-${userInfo().uid}`,
  ),
  // Where an image dropped into the panel's composer is written for the pane's Claude to read.
  //
  // Under the per-user runtime root rather than a shared or temporary directory, because the pane
  // and the sidecar are always the same login session -- the pane is resolved out of THIS user's
  // `~/.claude/sessions` -- so 0700 is exactly the right reach. `composerImages.ts` sweeps it.
  composerImageDirectory: directoryEnvironment(
    "AGENT_FEED_COMPOSER_IMAGE_DIR",
    join(runtimePaths().root, "agent-panel", "composer-images"),
  ),
  codexHomeDirectory: directoryEnvironment(
    "AGENT_FEED_CODEX_HOME",
    join(userHomeDirectory, ".codex"),
  ),
  piAgentDirectory: directoryEnvironment(
    "AGENT_FEED_PI_AGENT_DIR",
    getAgentDir(),
  ),
  piSessionsDirectory: directoryEnvironment(
    "AGENT_FEED_PI_SESSIONS_DIR",
    process.env.PI_CODING_AGENT_SESSION_DIR || join(getAgentDir(), "sessions"),
  ),
  piIdleRuntimeMs: integerEnvironment(
    "AGENT_FEED_PI_IDLE_RUNTIME_MS",
    10 * 60 * 1000,
    1000,
    24 * 60 * 60 * 1000,
  ),
  piToolCallBudget: integerEnvironment(
    "AGENT_FEED_PI_TOOL_CALL_BUDGET",
    64,
    1,
    1024,
  ),
  discoveryRescanMs: integerEnvironment(
    "AGENT_FEED_DISCOVERY_RESCAN_MS",
    60_000,
    1_000,
    10 * 60_000,
  ),
  staleThresholdMs,
  readyThresholdMs,
  liveWindowMs: integerEnvironment(
    "AGENT_FEED_LIVE_WINDOW_MS",
    2 * 60 * 1000,
    1000,
    30 * 60 * 1000,
  ),
  // How often a subscribed session re-probes its background tasks. The probe forks `lsof`, so
  // this is the knob that decides what the feature costs; 2s is well inside human patience for
  // "a task started" while keeping the fork rate low. Only sessions with an open subscriber poll.
  backgroundTaskPollMs: integerEnvironment(
    "AGENT_FEED_BACKGROUND_TASK_POLL_MS",
    2000,
    250,
    60_000,
  ),
  // How long a live shell the transcript cannot corroborate must have been running before the
  // panel shows it.
  //
  // This is a duration heuristic and there is no honest way to dress it as anything else: a
  // command promoted to the background after it started is indistinguishable from a foreground
  // one until it ends (ADR-0099), so elapsed time is the only separator available. Lower catches
  // promoted tasks sooner and shows more ordinary foreground work; higher is quieter and misses
  // the first stretch of a promoted task. Chosen by the owner at 5s, which is deliberately near
  // the noisy end -- seeing the agent's routine commands was judged the lesser cost against
  // missing a ten-minute build entirely.
  backgroundTaskUncorroboratedMs: integerEnvironment(
    "AGENT_FEED_BACKGROUND_TASK_UNCORROBORATED_MS",
    5000,
    0,
    10 * 60_000,
  ),
  contextWindows: contextWindowEnvironment("AGENT_FEED_CONTEXT_WINDOWS"),
  proxyObserverEndpoint: urlEnvironment(
    "AGENT_FEED_PROXY_OBSERVER_ENDPOINT",
    "http://127.0.0.1:9155",
  ),
  claudeLiveEnabled: booleanEnvironment("AGENT_FEED_CLAUDE_LIVE_ENABLED", true),
  claudeLiveReconnectMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_LIVE_RECONNECT_MS",
    1000,
    50,
    60_000,
  ),
  claudeLiveReconnectMaxMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_LIVE_RECONNECT_MAX_MS",
    30_000,
    1_000,
    5 * 60_000,
  ),
  claudeLiveMaxSessions: integerEnvironment(
    "AGENT_FEED_CLAUDE_LIVE_MAX_SESSIONS",
    64,
    1,
    512,
  ),
  claudeLiveIdleDropMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_LIVE_IDLE_DROP_MS",
    30_000,
    1_000,
    10 * 60_000,
  ),
  codexLiveEnabled: booleanEnvironment("AGENT_FEED_CODEX_LIVE_ENABLED", true),
  codexLiveReconnectMs: integerEnvironment(
    "AGENT_FEED_CODEX_LIVE_RECONNECT_MS",
    1000,
    50,
    60_000,
  ),
  codexLiveReconnectMaxMs: integerEnvironment(
    "AGENT_FEED_CODEX_LIVE_RECONNECT_MAX_MS",
    30_000,
    1_000,
    5 * 60_000,
  ),
  codexLiveMaxSessions: integerEnvironment(
    "AGENT_FEED_CODEX_LIVE_MAX_SESSIONS",
    64,
    1,
    512,
  ),
  codexLiveIdleDropMs: integerEnvironment(
    "AGENT_FEED_CODEX_LIVE_IDLE_DROP_MS",
    30_000,
    1_000,
    10 * 60_000,
  ),

  // The on-demand turn summarizer.
  //
  // Provider and model name entries in Pi's OWN catalog rather than describing an endpoint:
  // `opencode-go/deepseek-v4-flash` arrives from Pi already carrying its base URL, its
  // `thinkingFormat`, its 1M context window and its cost table, all of which a hand-written
  // models.json here would have restated worse. A different provider is a config change; an
  // endpoint Pi has never heard of would be a models.json, and is not v0.
  //
  // Absent key means the feature reports itself off rather than rendering a button that fails on
  // press, which is why `summaryEnabled` is derived here and not inferred from a request that
  // already went out.
  summaryApiKey,
  summaryEnabled: summaryApiKey !== null,
  summaryProvider: process.env.AGENT_FEED_SUMMARY_PROVIDER?.trim() || "opencode-go",
  summaryModel: process.env.AGENT_FEED_SUMMARY_MODEL?.trim() || "deepseek-v4-flash",
  // How much of a turn the summarizer is allowed to be shown, measured against the RENDERED
  // prompt rather than the raw events -- a tool result costs a few hundred characters there, not
  // the megabyte it came from. A turn longer than this is truncated in the middle and SAYS SO on
  // the result; the alternative is a request the model refuses, which reads to the viewer as a
  // broken button rather than a long conversation.
  summaryTokenCeiling: integerEnvironment(
    "AGENT_FEED_SUMMARY_TOKEN_CEILING",
    200_000,
    1_000,
    1_000_000,
  ),
  // A summarizer that never answers has to fail rather than hold the request open: the panel
  // shows a spinner until this fires, and an unbounded one is indistinguishable from a hang.
  summaryTimeoutMs: integerEnvironment(
    "AGENT_FEED_SUMMARY_TIMEOUT_MS",
    180_000,
    5_000,
    900_000,
  ),

  // Where the per-day usage sweep remembers which session files it has already summed.
  //
  // A cache in the macOS sense of the word -- derived, disposable, rebuilt by rereading the
  // vendors' own files -- so it lives in `Library/Caches` rather than beside durable state. The
  // two host tiers share one file deliberately: its contents are a function of the vendor
  // records alone, identical for both, and writes are atomic.
  usageCachePath: resolve(
    process.env.AGENT_FEED_USAGE_CACHE_PATH?.trim()
      || join(userHomeDirectory, "Library", "Caches", "agentdesk-agent-feed", "usage.json"),
  ),

  // The curated Bot roster. Shared by stable and dev sidecars because it names machine-level
  // projects and provider sessions, not one host process's ephemeral runtime. The file itself is
  // the authority; project directories deliberately receive no mirrored bot metadata.
  botsPath: resolve(
    process.env.AGENT_FEED_BOTS_PATH?.trim()
      || join(
        userHomeDirectory,
        "Library",
        "Application Support",
        "agentdesk-agent-feed",
        "bots.json",
      ),
  ),

  // The sidecar speaks the pty-manager protocol directly for Agent Feed terminals. The host
  // launch recipes override this for the dev tier; the stable path is the from-source default
  // so an already-running live sidecar can pick the feature up without a host rebuild.
  ptyManagerSocketPath: resolve(
    process.env.AGENT_FEED_PTY_MANAGER_SOCKET?.trim()
      || join(
        userHomeDirectory,
        "Library",
        "Application Support",
        "com.example.agentdesk.AgentDeskHost",
        "pty-manager.sock",
      ),
  ),

  // Desktop park. A window renders only while it is on the active Space and not
  // completely covered, so showing many windows at once means bringing them all
  // to one Desktop and leaving a strip of each one uncovered. Geometry and
  // rationale: docs/superpowers/specs/2026-08-25-desktop-park-manifest-design.md
  yabaiPath: yabaiBinary(),
  // The terminal grid attaches to sessions this multiplexer already holds, rather than starting
  // its own: a session running in tmux is one somebody is already watching from a real terminal,
  // and tmux is what makes a second viewer of it legal.
  tmuxPath: tmuxBinary(),
  // How much of each parked window stays on the display. macOS clamps to 40pt
  // horizontally, so this is the ceiling as well as the default.
  parkStrip: integerEnvironment("AGENT_FEED_PARK_STRIP", 40, 1, 400),
  // Vertical distance between rungs, and so the height of each window's
  // exclusive band. 1pt was measured to be enough; this is not 1pt because the
  // clamp is undocumented and a band that vanishes is a window that stops
  // rendering with nothing to report it.
  parkStep: integerEnvironment("AGENT_FEED_PARK_STEP", 24, 1, 400),
  // Top of the shallowest rung. Clears the menu bar, which is the one edge
  // macOS refuses to let a window hide under.
  parkTopMargin: integerEnvironment("AGENT_FEED_PARK_TOP_MARGIN", 39, 0, 400),
  // How long to let the window server finish reordering after a gather, before
  // the stacking order is re-read. Offsets have to run monotonically with the
  // real order, so reading it too early lays a ladder against a stale one.
  parkSettleMs: integerEnvironment("AGENT_FEED_PARK_SETTLE_MS", 900, 0, 10_000),
  // Build outputs are disposable. Both the live and compiled sidecar spawn the
  // installed helper, whose location is shared with the deployment recipes.
  gridEncoderPath: runtimePaths().gridEncoder,
  gridEncoderSlotsDirectory: runtimePaths().gridEncoderSlots,
  // Claude Desktop's main binary. The parent chain of a `--resume` child reaching THIS path is what
  // identifies the window that owns a session; a chain that stops at a shell or tmux is a terminal
  // session with no window to write into. Env-overridable so a non-default install location does not
  // need a code change.
  claudeDesktopMainPath: process.env.AGENTDESK_CLAUDE_MAIN_PATH?.trim()
    || "/Applications/Claude.app/Contents/MacOS/Claude",
  // Matched in BOTH argv spellings, because both are live on a normal machine and they mean
  // different things here. Claude Desktop's embedded CLI passes `--resume=<id>`, a terminal session
  // passes `--resume <id>`. Scanning only the first would report an open terminal session as "not
  // running" rather than "terminal only", which is the wrong answer on screen and hides the fact
  // that the session is open at all.
  claudeResumeFlag: process.env.AGENTDESK_CLAUDE_RESUME_MARK?.trim() || "--resume",
  // Only a Desktop-spawned coding session carries this `entrypoint`; a terminal session reads `cli`.
  // Env-overridable because it is another application's private field and can change without notice.
  claudeDesktopRegistryEntrypoint: process.env.AGENTDESK_CLAUDE_REGISTRY_ENTRYPOINT?.trim()
    || "claude-desktop",
  // The backstop cadence for re-resolving a watched session against the process table.
  //
  // It used to be the primary mechanism at 3s. Composer text, the question panel, application
  // launches and terminations, and Desktop switches are all pushed by the helper now, so the only
  // thing left for a timer is a `claude --resume` child appearing or exiting -- which macOS
  // publishes no notification for without EndpointSecurity. That is a real gap, not a solved one,
  // so the timer stays; it just no longer carries the responsive cases.
  claudeWindowResolveIntervalMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_WINDOW_RESOLVE_INTERVAL_MS",
    30_000,
    250,
    60_000,
  ),
  // The bridged SkyLight move reports DISPATCH, not WindowServer convergence, so the helper re-reads
  // the window's Space membership to decide whether it landed. That read has to be retried: a single
  // immediate one races the operation and reports `move-failed` for a move that was seconds from
  // taking, which strands the window on the wrong Desktop AND blames the wrong step. The numbers live
  // here rather than in the helper because they are a timing policy, not a capability.
  claudeWindowMoveVerifyAttempts: integerEnvironment(
    "AGENT_FEED_CLAUDE_WINDOW_MOVE_VERIFY_ATTEMPTS",
    4,
    1,
    50,
  ),
  claudeWindowMoveVerifyIntervalMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_WINDOW_MOVE_VERIFY_INTERVAL_MS",
    50,
    5,
    2_000,
  ),
  // Codex Desktop is hosted by ChatGPT.app. A process whose argv is exactly this path is the app's
  // main process; a wrong pid degrades to "no window" at targeting, never to a write against another
  // application. Env-overridable like the Claude one.
  codexDesktopMainPath: process.env.AGENTDESK_CODEX_MAIN_PATH?.trim()
    || "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
  // The app's own thread registry, and its display-title index. `threads` rows carry `cwd` and a
  // lowercased `title`; the title a window actually SHOWS is the `thread_name` in the JSONL, which
  // matches the accessibility header exactly.
  codexStateSqlite: process.env.AGENTDESK_CODEX_STATE_SQLITE?.trim()
    || join(userHomeDirectory, ".codex", "state_5.sqlite"),
  codexSessionIndex: process.env.AGENTDESK_CODEX_SESSION_INDEX?.trim()
    || join(userHomeDirectory, ".codex", "session_index.jsonl"),
  // How long a Codex window is given to build its accessibility tree. Unlike Claude there is no
  // `AXManualAccessibility` latch to set -- the attribute is unsupported on this app -- so attaching
  // and waiting is the only mechanism, and the tree only builds for a window on the active Desktop.
  codexTreeMaterializeTimeoutMs: integerEnvironment(
    "AGENT_FEED_CODEX_TREE_MATERIALIZE_TIMEOUT_MS", 20_000, 250, 120_000,
  ),
  // Renderer revive gates. The composer must be CONTINUOUSLY missing for the first, so a tree that
  // flaps on a sub-minute cycle is never killed and a genuinely wedged one recovers inside it; the
  // second bounds a tree that never rebuilds to one kill per Claude process per window. Each kill
  // reloads a window the user is looking at, which is why neither is aggressive.
  claudeRendererReviveMinMissingMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_RENDERER_REVIVE_MIN_MISSING_MS", 8_000, 1_000, 600_000,
  ),
  claudeRendererReviveCooldownMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_RENDERER_REVIVE_COOLDOWN_MS", 60_000, 1_000, 3_600_000,
  ),
  // How long a respawned web contents gets to build its tree before the caller gives up and lets the
  // poll retry.
  claudeRendererReviveWaitMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_RENDERER_REVIVE_WAIT_MS", 3_000, 250, 60_000,
  ),
  // How long a window brought to this Desktop gets to materialize its composer. Chromium builds a
  // window's tree lazily and only for the current Space, so the first search after a move-in
  // reliably misses and this is the budget for it appearing.
  claudeComposerMaterializeTimeoutMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_COMPOSER_MATERIALIZE_TIMEOUT_MS", 20_000, 250, 120_000,
  ),
  claudeComposerMaterializePollMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_COMPOSER_MATERIALIZE_POLL_MS", 200, 10, 5_000,
  ),
  // How long a written value gets to commit and read back before the write is judged. Chromium
  // commits asynchronously and a contents mid-rebuild answers the first read with the old value.
  claudeComposerVerifySettleMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_COMPOSER_VERIFY_SETTLE_MS", 2_000, 100, 60_000,
  ),
  // How long a submitted composer gets to clear before the send is reported as not obviously landed.
  claudeComposerSubmitSettleMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_COMPOSER_SUBMIT_SETTLE_MS", 2_000, 100, 60_000,
  ),
  claudeComposerSettlePollMs: integerEnvironment(
    "AGENT_FEED_CLAUDE_COMPOSER_SETTLE_POLL_MS", 100, 10, 5_000,
  ),
  // How long a `--control` helper waits without a command before ending itself. It exists because
  // `bun --watch` reloads this module graph IN THE SAME PID: a helper spawned before a reload is
  // referenced by nothing afterwards and no code here will ever kill it. An orphan receives nothing
  // by definition, so silence is the signal. Long enough to survive a quiet panel, short enough
  // that a rebuilt binary is not shadowed by yesterday's process.
  desktopHelperIdleSeconds: integerEnvironment(
    "AGENT_FEED_DESKTOP_HELPER_IDLE_SECONDS",
    30,
    5,
    3_600,
  ),
  // A helper verb answers in single-digit milliseconds unless it is moving a window between
  // Desktops, which waits on the window server. Past this the request failed, and reporting that is
  // better than a panel field that never resolves.
  desktopHelperRequestTimeoutMs: integerEnvironment(
    "AGENT_FEED_DESKTOP_HELPER_REQUEST_TIMEOUT_MS",
    8_000,
    250,
    60_000,
  ),
  // Werift's stock sender retains only 128 RTP packets for NACK repair. LTE traces showed
  // requests continuing after that ring had been overwritten, so the repository patch makes
  // the history an explicit peer option and this central knob raises it to roughly 6 seconds
  // at the measured high-motion packet rate. The RTP sequence space is the hard upper bound.
  webrtcRtpHistoryPackets: integerEnvironment(
    "AGENT_FEED_WEBRTC_RTP_HISTORY_PACKETS",
    1024,
    1,
    65_536,
  ),
  // Durable state, not a cache: it is the only record of where each parked
  // window came from, so losing it makes the park a one-way trip.
  // The workspace IDE's roster of project roots, and the open-tab state every reader of one
  // workspace shares. Beside the Bot roster and for the same reason: both name machine-level
  // projects rather than one host process's runtime, so the stable and dev sidecars share them.
  workspacesPath: resolve(
    process.env.AGENT_FEED_WORKSPACES_PATH?.trim()
      || join(
        userHomeDirectory,
        "Library",
        "Application Support",
        "agentdesk-agent-feed",
        "workspaces.json",
      ),
  ),
  workspaceStatePath: resolve(
    process.env.AGENT_FEED_WORKSPACE_STATE_PATH?.trim()
      || join(
        userHomeDirectory,
        "Library",
        "Application Support",
        "agentdesk-agent-feed",
        "workspace-state.json",
      ),
  ),

  // What the IDE will load. Text is capped where an editor stops being useful and starts being a
  // way to make the sidecar allocate; a document is capped higher because a docx carries its
  // images inside it.
  workspaceMaxTextBytes: Number(process.env.AGENT_FEED_WORKSPACE_MAX_TEXT_BYTES ?? 4 * 1024 * 1024),
  workspaceMaxDocumentBytes: Number(
    process.env.AGENT_FEED_WORKSPACE_MAX_DOCUMENT_BYTES ?? 32 * 1024 * 1024,
  ),

  parkManifestPath: resolve(
    process.env.AGENT_FEED_PARK_MANIFEST_PATH?.trim()
      || join(
        userHomeDirectory,
        "Library",
        "Application Support",
        "agentdesk-agent-feed",
        "park-manifest.json",
      ),
  ),
} as const;

/**
 * The model's context window in tokens, or null when this build has no entry.
 *
 * Null is a real answer, not a failure: the panel then shows the occupancy count
 * with no fill bar, rather than a fraction of a number we guessed.
 */
export function contextWindowFor(model: string | undefined): number | null {
  return contextWindowIn(config.contextWindows, model);
}
