// First, so the SDK is set up before anything it should see (telemetry/sidecarTelemetry.ts).
import { sidecarListening, traceRequest } from "@/telemetry/sidecarTelemetry";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import type { SidecarConfig } from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import { refuseForeignRequest } from "@/http/protocol/requestGuard";
import { announceDirectory, announceSidecar, readSupervisorDescriptor } from "@/sidecarRegistry";
import { createSupervisorRoutes } from "@/http/supervisorRoutes";
import { createTelemetryRoutes } from "@/telemetry/telemetryRoutes";
import { sinkEnvelope } from "@/telemetry/telemetrySink";
import {
  BYE_BYTES,
  errorResponse,
  jsonResponse,
} from "@/http/protocol/httpResponses";
import { createAgentRoutes } from "@/http/agent-routes/agentRoutes";
import { createStartSessionRoutes } from "@/http/agent-routes/startSessionRoutes";
import { createHandoverRoutes, LIVE_HANDOVER_ACTIONS } from "@/http/agent-routes/handoverRoutes";
import { createOpencodeRoutes } from "@/http/agent-routes/opencodeRoutes";
import { createBotRoutes } from "@/http/botRoutes";
import { createCliSessionRoutes } from "@/http/session-routes/cliSessionRoutes";
import {
  createTmuxComposerRoutes,
  liveTmuxComposerDependencies,
} from "@/http/session-routes/tmuxComposerRoutes";
import { createTmuxQuestionRoutes } from "@/http/session-routes/tmuxQuestionRoutes";
import { createClaudeSdkRoutes } from "@/claude-sdk/claudeSdkRoutes";
import { answerTmuxQuestion } from "@/input/question/questionAnswer";
import { pointTmuxQuestion } from "@/input/question/questionPoint";
import { createInventoryRoutes } from "@/http/inventoryRoutes";
import { createParkRoutes } from "@/http/parkRoutes";
import { createWindowRoutes } from "@/http/windowRoutes";
import { createWebrtcTileRoutes } from "@/http/tile/tile-peer/webrtcTileRoutes";
import type { RouteHandler } from "@/http/protocol/route";
import { createSessionRoutes } from "@/http/session-routes/sessionRoutes";
import { createSessionArchiveRoutes, liveSessionCheck } from "@/http/agent-routes/sessionArchiveRoutes";
import { installSessionArchive, SessionArchiveStore } from "@/transcripts/session-ops/sessionArchive";
import { broadcast as broadcastCatalog } from "@/transcripts/catalog/catalogState";
import { createBracketRoutes } from "@/http/session-routes/bracketRoutes";
import { createEventImageRoutes } from "@/http/session-routes/eventImageRoutes";
import { createSummaryRoutes } from "@/http/session-routes/summaryRoutes";
import { createTaskRoutes } from "@/http/session-routes/taskRoutes";
import { createAgentTerminalRoutes } from "@/http/agent-routes/agentTerminalRoutes";
import { createTmuxRoutes } from "@/http/tmuxRoutes";
import { createSubagentRoutes } from "@/http/session-routes/subagentRoutes";
import { createTimelineRoutes } from "@/http/session-routes/timelineRoutes";
import { createLimitsRoutes } from "@/http/limitsRoutes";
import { createOpencodeGoLimitsRoute } from "@/http/opencodeGoLimitsRoute";
import { createUsageRoutes } from "@/http/usageRoutes";
import { createWorkspaceFileRoutes } from "@/http/workspace-routes/workspaceFileRoutes";
import { createWorkspaceHistoryRoutes } from "@/http/workspace-routes/workspaceHistoryRoutes";
import { createWorkspaceSearchRoutes } from "@/http/workspace-routes/workspaceSearchRoutes";
import { createWorkspaceRoutes } from "@/http/workspace-routes/workspaceRoutes";
import { createWorkspaceStreamRoutes } from "@/http/workspace-routes/workspaceStreamRoutes";
import { WorkspaceSharedStateStore } from "@/workspace/workspaceSharedState";
import { RepositoryGitWatch } from "@/workspace/repositoryWatch";
import { WorkspaceService } from "@/workspace/workspaceService";
import { WorkspaceStore } from "@/workspace/workspaceStore";
import { createUsageScanner, detectUsageVendors } from "@/usage/usageReport";
import { state } from "@/transcripts/transcriptState";
import {
  getSnapshot,
  getWatcherState,
  findSession,
  summarizeSession,
  subscribeCatalog,
  startCatalog,
  catalogReady,
  stopCatalog,
  registerPiSession,
  resolvePiSession,
  notifyPiSessionChanged,
  registerOpencodeSession,
  resolveOpencodeSession,
  scheduleOpencodeReconcile,
} from "@/transcripts/catalog/transcriptCatalog";
import { AgentBackendRegistry } from "@/agents/agentBackend";
import { PiAgentBackend } from "@/agents/piAgentBackend";
import { OpencodeAgentBackend } from "@/agents/opencode/opencodeAgentBackend";
import { ClaudeLiveBackend } from "@/live/claudeLiveBackend";
import { CodexLiveBackend } from "@/live/codexLiveBackend";
import { startArenaService } from "@/arena/arenaWiring";
import { createArenaCodeRoutes } from "@/http/arenaCodeRoutes";
import { createArenaRoutes } from "@/http/arenaRoutes";
import { BotStore } from "@/bots/botStore";
import { startLiveIdleSessionSweep } from "@/terminal/session-panes/idleSessionSweep";
import { BotRegistry } from "@/bots/botRegistry";
import type { BotRegistryCatalog } from "@/bots/botTypes";
import type { BotSessionRenamer } from "@/bots/sessions/botTitleNormalize";
import { BotTitleQueue } from "@/bots/sessions/botTitleQueue";
import { subscribeSessionPaneStarts } from "@/terminal/session-panes/sessionPaneStarts";
import { awaitComposer } from "@/input/tmuxComposer";
import { startHubBotPublisher } from "@/messaging/hubBotPublisher";
import { HubClient, loadHubSettings } from "@/messaging/hubClient";
import { HubOpencodeAdapter, liveOpencodeServePort } from "@/messaging/hubOpencode";
import { createHubRoutes } from "@/messaging/hubRoutes";
import { bindableDirectory } from "@/bots/botDirectory";
import { createAddBotTool } from "@/bots/addBotTool";
import { renameClaudeSession } from "@/transcripts/session-ops/renameSession";
import { AgentTerminalService } from "@/terminal/agentTerminalService";
import { userShellPath } from "@/terminal/userShellPath";
import { sourceVersion } from "@/sourceVersion";

/**
 * The code this process read, hashed once as it starts. Every module is loaded by the time the
 * first request is served, and nothing re-reads them, so this is the version for its whole life.
 */
const SOURCE_VERSION = sourceVersion(new URL("../..", import.meta.url).pathname);

// Pi normally lazy-loads OAuth providers from sibling files. A standalone Bun
// executable has no such files beside it, so use Pi's static loader registry to
// make every supported OAuth implementation part of the compiled sidecar.
registerBunOAuthFlows();

const backends = new AgentBackendRegistry();
const resolveBackend = (id: string) => backends.get(id);
const describeAgentSession = (source: string, sessionId: string) =>
  backends.get(source)?.describeSession(sessionId);
const botStore = new BotStore(config.botsPath);
const sessionArchive = new SessionArchiveStore(config.sessionArchivePath);
installSessionArchive(sessionArchive);
// Rows summarized before the file was read went out unarchived; republish once it has been.
void sessionArchive.ready().then(
  () => broadcastCatalog(),
  (error: unknown) => console.error("agent feed session archive failed to load", error),
);
const botCatalog: BotRegistryCatalog = {
  resolveProject(path) {
    // The catalog first, then any directory this machine has under home: a project nobody has
    // started a session in yet is not in the catalog, and it is the one the panel's folder picker
    // exists to bind. `botDirectory.ts` carries the confinement and why it is there.
    return bindableDirectory(path, (candidate) =>
      getSnapshot().some((session) => session.project === candidate));
  },
  resolveSession(ref) {
    const session = findSession(ref.source, ref.sessionId);
    return session
      ? {
        projectPath: session.project,
        summary: summarizeSession(session, describeAgentSession),
        ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
      }
      : undefined;
  },
  subscribe(listener) {
    return subscribeCatalog(() => listener());
  },
  ready: catalogReady,
};
const botRegistry = new BotRegistry(botStore, botCatalog);
// Closes Claude sessions that are off the canvas and have gone quiet; see the module for the rules.
startLiveIdleSessionSweep(botStore);
// Asked now rather than at the first launch, which would otherwise wait on the user's ~/.zshrc.
void userShellPath();
const agentTerminals = new AgentTerminalService(
  config.ptyManagerSocketPath,
  (source, sessionId) => {
    const session = findSession(source, sessionId);
    if (!session) return undefined;
    const summary = summarizeSession(session, describeAgentSession);
    const { project: projectPath, lastEntrypoint } = session;
    return { projectPath, activity: summary.activity, title: summary.title, lastEntrypoint };
  },
);
backends.register(new PiAgentBackend({
  resolveSession: resolvePiSession,
  onSessionCreated: registerPiSession,
  onSessionChanged: notifyPiSessionChanged,
  customToolsForSession: async ({ source, sessionId }) =>
    await botRegistry.botAllowedToAdd({ source, sessionId })
      ? [createAddBotTool(botRegistry, { source, sessionId })]
      : [],
}));
// Opencode sessions are owned by the serve on this machine, not by files the
// catalog watches: the backend reads them over the SDK client while the
// catalog reconciler lists them, the same split Pi keeps between runtime and
// registry. No password crosses this boundary -- the client holder keeps it.
const opencodeBackend = new OpencodeAgentBackend({
  resolveSession: resolveOpencodeSession,
  onSessionCreated: registerOpencodeSession,
  onCatalogChanged: scheduleOpencodeReconcile,
});
backends.register(opencodeBackend);
// Read-only live mirror of Claude Code traffic observed through proxy-agent.
// Registered unconditionally so its routes answer with a precise "unknown
// source" when the observer endpoint is unreachable; `start()` degrades to a
// quiet no-op when disabled.
const claudeLive = new ClaudeLiveBackend();
backends.register(claudeLive);
// Read-only live mirror of Codex Desktop traffic observed through proxy-agent,
// with the same registration contract as the claude live mirror.
const codexLive = new CodexLiveBackend();
backends.register(codexLive);
// The workspace IDE's own state. Started here rather than lazily on the first request so a
// malformed store on disk fails the sidecar at launch, where it is one line in the log, rather
// than as a 500 on whichever request happened to touch it first.
// One watch per repository for every reader of its git status: the IDE's workspaces and the Bots'
// headers, which often sit on the same checkout.
const repositoryGitWatch = new RepositoryGitWatch();
const workspaceService = new WorkspaceService(
  new WorkspaceStore(config.workspacesPath),
  new WorkspaceSharedStateStore(config.workspaceStatePath),
  repositoryGitWatch,
);
void workspaceService.ready().catch((error: unknown) => {
  console.error("workspace service failed to start", error);
});

// One scanner for both usage routes, so the meters route can answer from whatever the last sweep
// read instead of starting one of its own. Two scanners would also mean two in-flight sweeps of
// the same gigabytes, since the coalescing that prevents that lives inside one of them.
const usageScanner = createUsageScanner();

// Renames through the same doors the Rename dialog uses: Claude's own `/rename` in its pane,
// opencode's serve through its backend. Anything else has no mechanism and is reported, not
// failed. One closure because three callers need it: the Bot routes' completion path, the
// opencode adapter answering hub directives, and the title queue below.
const renamableSources = new Set<string>(["claude", "opencode"]);
/** How long a reopened session has to draw its composer before its rename waits for it to move. */
const SESSION_READY_LIMIT_MS = 60_000;
const renameSession: BotSessionRenamer = async (ref, title) => {
  if (ref.source === "claude") {
    await renameClaudeSession(ref.sessionId, title);
    return;
  }
  if (ref.source === "opencode") {
    await opencodeBackend.renameSession(ref.sessionId, title);
    return;
  }
  throw new Error(`sessions from ${ref.source} cannot be renamed`);
};

// Every Bot session on this machine wears its anchor: a running one is renamed now, a stopped one
// once it starts again. `botTitleQueue.ts` carries why it is derived rather than stored.
new BotTitleQueue({
  store: botStore,
  catalog: botCatalog,
  renamer: renameSession,
  renamable: (source) => renamableSources.has(source),
  paneStarts: subscribeSessionPaneStarts,
  // A just-started Claude draws its composer when it has loaded, and nothing announces that, so
  // this is the same bounded wait a fork's rewind uses. Opencode renames through its serve.
  whenReady: (ref) =>
    ref.source === "claude" ? awaitComposer(ref.sessionId, SESSION_READY_LIMIT_MS) : Promise.resolve(true),
}).start();

const arenaService = startArenaService(opencodeBackend);

const routes: RouteHandler[] = [
  // The one route about the process ABOVE this one: its state rides on `/api/config` and this is
  // how a reader's answer gets back to it, since a supervisor has no port of its own.
  createSupervisorRoutes(),
  createTelemetryRoutes(sinkEnvelope),
  createArenaRoutes(arenaService),
  createArenaCodeRoutes(arenaService, repositoryGitWatch, {
    maxTextBytes: config.workspaceMaxTextBytes,
    maxDocumentBytes: config.workspaceMaxDocumentBytes,
  }),
  createInventoryRoutes(describeAgentSession),
  createBotRoutes(botRegistry, repositoryGitWatch, {
    maxTextBytes: config.workspaceMaxTextBytes,
    maxDocumentBytes: config.workspaceMaxDocumentBytes,
  }),
  createAgentTerminalRoutes(agentTerminals),
  createTmuxRoutes(),
  // Ahead of the generic agent-session routes: opencode's own paths live under the same
  // prefix, and the slash-command half of them answers first.
  createOpencodeRoutes(resolveBackend),
  createHandoverRoutes(resolveBackend, {
    ...LIVE_HANDOVER_ACTIONS,
    bots: {
      exists: async (botId) => (await botRegistry.snapshot()).bots.some((bot) => bot.botId === botId),
      attach: async (botId, ref) => {
        await botRegistry.attachStartedSession(botId, ref, { kind: "user" });
      },
    },
  }),
  createStartSessionRoutes(resolveBackend),
  createAgentRoutes(resolveBackend),
  // Ahead of the session routes so `/timeline` is matched before their
  // catch-all rejection of unknown `/api/sessions/` paths.
  createTimelineRoutes(resolveBackend, describeAgentSession),
  // Ahead of them for the same reason: `/tasks` and `/tasks/<id>/output` live under
  // `/api/sessions/` and would otherwise be rejected before they are matched.
  createTaskRoutes(),
  // And again: `/input` is under `/api/sessions/` too.
  createCliSessionRoutes(),
  // And `/agents/<id>/transcript`, which is under `/api/sessions/` for the same reason: a
  // subagent belongs to the session that launched it and is addressed through it.
  createSubagentRoutes(),
  // And `/composer`, which is the other way of typing at the same session. It takes the pane
  // signal from the terminal service because that service owns the pane's one pipe.
  createTmuxComposerRoutes(liveTmuxComposerDependencies(
    (pane, onOutput) => agentTerminals.watchPane(pane, onOutput),
  )),
  // And `/question`, which drives the same keyboard at the dialog that replaces that composer
  // while Claude is waiting for an answer. No pane signal: it is one operation, not a watch.
  // Two drivers behind one path, split by what each may press: `answer` may press the keys that
  // finish the call, `point` only the arrows that move a cursor without committing anything.
  createTmuxQuestionRoutes({ answer: answerTmuxQuestion, point: pointTmuxQuestion }),
  createClaudeSdkRoutes(claudeLive), // `/sdk/...`, a session run through the Agent SDK (ADR-0143)
  // Same reason again: `/summary` lives under `/api/sessions/`.
  createSummaryRoutes(resolveBackend, describeAgentSession),
  // And `/events/<n>/blocks/<b>/image`, the picture behind an image block.
  createEventImageRoutes((sessionId, eventIndex, blockIndex) => {
    const backend = resolveBackend("opencode") as {
      opencodeImage?: (
        sessionId: string,
        eventIndex: number,
        blockIndex: number,
      ) => { mediaType: string; data: string } | null;
    } | undefined;
    return backend?.opencodeImage?.(sessionId, eventIndex, blockIndex) ?? null;
  }),
  // Not under `/api/sessions/` at all -- usage is a fact about the machine -- so its position
  // here is only for readability.
  createUsageRoutes(usageScanner),
  // The rate-limit meters on their own, for the surfaces that want the meter without the sweep
  // behind it. Given the same scanner so Codex's meter comes from whatever the last sweep read.
  createLimitsRoutes(usageScanner),
  // The OpenCode Go plan meter, polled only while a panel has one on screen.
  createOpencodeGoLimitsRoute(),
  createParkRoutes(),
  // Desktop and window reads through the standalone helper. Not under `/api/sessions/`, so its
  // position here is only for readability.
  createWindowRoutes(),
  createWebrtcTileRoutes(),
  // The workspace IDE. Ahead of the session routes only for readability; none of these paths is
  // under `/api/sessions/`. The stream is listed before the others so `/stream` is matched before
  // the roster routes walk the same `/api/workspaces/<id>/` shape.
  createWorkspaceStreamRoutes(workspaceService),
  createWorkspaceFileRoutes(workspaceService, {
    maxTextBytes: config.workspaceMaxTextBytes,
    maxDocumentBytes: config.workspaceMaxDocumentBytes,
  }),
  createWorkspaceHistoryRoutes(workspaceService),
  createWorkspaceSearchRoutes(workspaceService, config.ripgrepPath),
  createWorkspaceRoutes(workspaceService),
  // And `/bracket`, which names what one session is doing: a session's address rather than a
  // Bot's, for the same reason forking moved off the Bot endpoint, and ahead of the catch-all
  // below for the same mechanical reason as the rest.
  createBracketRoutes(botRegistry, { renameSession }),
  // `/archive` and `/unarchive`, under `/api/sessions/` like the rest above.
  createSessionArchiveRoutes({ archive: sessionArchive, isRunning: liveSessionCheck(describeAgentSession) }),
  createSessionRoutes(describeAgentSession),
  // The agent messaging hub, spoken to as `human` on the panel's behalf (docs/agent-messaging.md).
  createHubRoutes(),
];
const SHUTDOWN_GRACE_MS = 500;

const server = Bun.serve<undefined>({
  hostname: config.host,
  port: config.port,
  // Bun closes an idle connection after 10 seconds by default, and it counts a
  // streaming response as idle. Every long-lived surface here outlives that: the
  // timeline and task SSE streams, and the tile stream, which is a video that is
  // supposed to run for as long as someone is watching. Left at the default it
  // hangs up at exactly ten seconds and the page sees a bare 500 with no body.
  // 0 disables it; the sidecar is a loopback service and its clients are the
  // panel and the host.
  idleTimeout: 0,
  fetch(request, bunServer) {
    const url = new URL(request.url);
    // The control API is unauthenticated on purpose: the sidecar binds to loopback, the tailnet
    // reaches only the panel in front of it, and the tailnet is the trust boundary. There is no
    // token to mint, plumb, or type in to add a session. The owner's own browser is not behind
    // that boundary, so a page of another site, or one rebound to loopback, is refused first.
    const refusal = refuseForeignRequest(request, config.allowedHosts);
    if (refusal) return refusal;
    if (request.method === "GET" && url.pathname === "/api/config") {
      const body: SidecarConfig = {
        staleThresholdMs: config.staleThresholdMs,
        readyThresholdMs: config.readyThresholdMs,
        liveWindowMs: config.liveWindowMs,
        watcherState: getWatcherState(),
        sessionCount: getSnapshot().length,
        // Whether the panel should offer the Summarize button. A process-global fact, so it
        // lives here rather than being copied identically onto every session's capabilities.
        summaryEnabled: config.summaryEnabled,
        summaryModel: config.summaryEnabled ? `${config.summaryProvider}/${config.summaryModel}` : null,
        // Recomputed per request rather than at startup: a machine that installs Codex while the
        // host is running should offer the surface without a relaunch, and the check is one
        // `existsSync`.
        usageVendors: detectUsageVendors(),
        // Whether this machine can gather windows onto one Desktop. Carried here
        // rather than probed by the panel: the relay admits only a few concurrent
        // requests per surface, and an extra availability call fired on mount
        // loses that race and reads as "this machine cannot do it".
        parkAvailable: config.yabaiPath !== null,
        // The machine's own shell rides tmux, on every machine. It used to prefer the PTY
        // manager where its socket was there -- this Mac -- and answer tmux only on peers, but the
        // two shells drifted apart and the peer's tmux one is what gets watched: a second viewer
        // of a tmux pane is legal by construction, while a PTY shell is one reader's. Read as a
        // constant rather than probed, so there is no priority left to prefer anything else.
        machineShell: "tmux",
        // Read per request, from the file this machine's supervisor heartbeats. It belongs on this
        // answer because the panel's dev server already asks every sidecar it knows for
        // `/api/config` on a timer to see whether it is alive, so a peer's held state crosses the
        // link with no request of its own -- and a peer is exactly the case a file cannot serve,
        // since the panel is on a different machine.
        supervisor: readSupervisorDescriptor(),
        sourceVersion: SOURCE_VERSION,
      };
      return jsonResponse(body);
    }
    return traceRequest(request, url, () => {
      for (const route of routes) {
        const response = route(request, url, bunServer);
        if (response !== undefined) return response;
      }
      // Coded, so the panel can tell "this sidecar has no such route" -- usually one running older
      // code than the panel calling it -- from a route that answered that its thing is missing.
      return errorResponse("route-not-found", `this sidecar has no route ${request.method} ${url.pathname}`, 404);
    });
  },
});

console.log(`agent feed sidecar listening on http://${config.host}:${server.port}`);
sidecarListening();
// Announce on the shared board so any panel on the machine can offer this session with no port
// hand-fed to it. Withdrawn in shutdown; a crash leaves a descriptor that ages out on its own.
// A sidecar pointed at its own announce directory joins a board of one instead, which is how a
// probe or an arena sidecar keeps this user's real entry intact.
const announcementDir = announceDirectory();
const announcement = announceSidecar(
  config.port,
  announcementDir ? { dir: announcementDir } : undefined,
);
void startCatalog()
  .then(async () => {
    await claudeLive.start();
    await codexLive.start();
    // Bots are published only once the catalog is up, so their session lists are not read empty.
    const hubSettings = loadHubSettings();
    if (typeof hubSettings === "string") {
      console.error(`[hub] ${hubSettings}; no Bots published and no opencode messages delivered`);
    } else {
      const hub = new HubClient(hubSettings);
      await startHubBotPublisher(botRegistry, hub);
      // OpenCode's streams live here rather than in a per-session child, because opencode runs one
      // MCP process per serve. The adapter opens one hub stream per session the serve lists and
      // writes each push as a queued prompt.
      const opencodeHub = new HubOpencodeAdapter({
        hub,
        serve: liveOpencodeServePort(() => void opencodeHub.sync()),
        log: (line) => console.error(`[hub-opencode] ${line}`),
        rename: (ref, task) => botRegistry.renameBracket(ref, task, renameSession),
      });
      opencodeHub.start();
      state.shutdownHooks.push(() => opencodeHub.stop());
    }
  })
  .catch((error) => {
    console.error("agent feed catalog startup failed", error);
    server.stop(true);
    process.exit(1);
  });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  state.shuttingDown = true;
  console.log(
    `agent feed sidecar ${signal}: draining ${state.openStreams.size} stream(s)`,
  );
  for (const stream of [...state.openStreams]) {
    try {
      stream.controller.enqueue(BYE_BYTES);
    } catch (error) {
      console.debug("agent feed stream closed before shutdown notice", error);
      stream.teardown();
    }
  }
  await Bun.sleep(SHUTDOWN_GRACE_MS);
  for (const stream of [...state.openStreams]) stream.teardown();
  announcement.stop();
  for (const hook of [...state.shutdownHooks].reverse()) {
    try {
      hook();
    } catch (error) {
      console.error("shutdown hook failed", error);
    }
  }
  await stopCatalog();
  agentTerminals.stop();
  try {
    await backends.dispose();
  } catch (error) {
    console.error("agent backend shutdown failed", error);
  }
  server.stop(true);
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
