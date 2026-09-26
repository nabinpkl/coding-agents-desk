import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { existsSync } from "node:fs";
import type { SidecarConfig } from "@agentdesk/agent-feed-wire";
import { config } from "@/config/config";
import { announceSidecar, readSupervisorDescriptor } from "@/sidecarRegistry";
import { createSupervisorRoutes } from "@/http/supervisorRoutes";
import {
  BYE_BYTES,
  jsonResponse,
} from "@/http/httpResponses";
import { createAgentRoutes } from "@/http/agentRoutes";
import { createBotRoutes } from "@/http/botRoutes";
import { createCliInputRoutes } from "@/http/session-routes/cliInputRoutes";
import { createRelayMcpHttpRoutes } from "@/mcp/relayHttpRoutes";
import {
  createTmuxComposerRoutes,
  liveTmuxComposerDependencies,
} from "@/http/session-routes/tmuxComposerRoutes";
import { createTmuxQuestionRoutes } from "@/http/session-routes/tmuxQuestionRoutes";
import { answerTmuxQuestion } from "@/input/question/questionAnswer";
import { pointTmuxQuestion } from "@/input/question/questionPoint";
import { createInventoryRoutes } from "@/http/inventoryRoutes";
import { createParkRoutes } from "@/http/parkRoutes";
import { createWindowRoutes } from "@/http/windowRoutes";
import { createWebrtcTileRoutes } from "@/http/tile-peer/webrtcTileRoutes";
import type { RouteHandler } from "@/http/route";
import { createSessionRoutes } from "@/http/session-routes/sessionRoutes";
import { createEventImageRoutes } from "@/http/session-routes/eventImageRoutes";
import { createSummaryRoutes } from "@/http/session-routes/summaryRoutes";
import { createTaskRoutes } from "@/http/session-routes/taskRoutes";
import { createAgentTerminalRoutes } from "@/http/agentTerminalRoutes";
import { createTmuxRoutes } from "@/http/tmuxRoutes";
import { createSubagentRoutes } from "@/http/session-routes/subagentRoutes";
import { createTimelineRoutes } from "@/http/session-routes/timelineRoutes";
import { createLimitsRoutes } from "@/http/limitsRoutes";
import { createUsageRoutes } from "@/http/usageRoutes";
import { createWorkspaceFileRoutes } from "@/http/workspace-routes/workspaceFileRoutes";
import { createWorkspaceHistoryRoutes } from "@/http/workspace-routes/workspaceHistoryRoutes";
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
import { BotStore } from "@/bots/botStore";
import { BotRegistry } from "@/bots/botRegistry";
import { bindableDirectory } from "@/bots/botDirectory";
import { createAddBotTool } from "@/bots/addBotTool";
import { AgentTerminalService } from "@/terminal/agentTerminalService";

// Pi normally lazy-loads OAuth providers from sibling files. A standalone Bun
// executable has no such files beside it, so use Pi's static loader registry to
// make every supported OAuth implementation part of the compiled sidecar.
registerBunOAuthFlows();

const backends = new AgentBackendRegistry();
const resolveBackend = (id: string) => backends.get(id);
const describeAgentSession = (source: string, sessionId: string) =>
  backends.get(source)?.describeSession(sessionId);
const botStore = new BotStore(config.botsPath);
const botRegistry = new BotRegistry(botStore, {
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
      ? { projectPath: session.project, summary: summarizeSession(session, describeAgentSession) }
      : undefined;
  },
  subscribe(listener) {
    return subscribeCatalog(() => listener());
  },
});
const agentTerminals = new AgentTerminalService(
  config.ptyManagerSocketPath,
  (source, sessionId) => {
    const session = findSession(source, sessionId);
    if (!session) return undefined;
    const summary = summarizeSession(session, describeAgentSession);
    return {
      projectPath: session.project,
      activity: summary.activity,
      title: summary.title,
    };
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
backends.register(new OpencodeAgentBackend({
  resolveSession: resolveOpencodeSession,
  onSessionCreated: registerOpencodeSession,
  onCatalogChanged: scheduleOpencodeReconcile,
}));
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

const routes: RouteHandler[] = [
  // The one route about the process ABOVE this one: its state rides on `/api/config` and this is
  // how a reader's answer gets back to it, since a supervisor has no port of its own.
  createSupervisorRoutes(),
  createInventoryRoutes(describeAgentSession),
  createBotRoutes(botRegistry, repositoryGitWatch, {
    maxTextBytes: config.workspaceMaxTextBytes,
    maxDocumentBytes: config.workspaceMaxDocumentBytes,
  }),
  createAgentTerminalRoutes(agentTerminals),
  createTmuxRoutes(),
  createAgentRoutes(resolveBackend),
  // Ahead of the session routes so `/timeline` is matched before their
  // catch-all rejection of unknown `/api/sessions/` paths.
  createTimelineRoutes(resolveBackend, describeAgentSession),
  // Ahead of them for the same reason: `/tasks` and `/tasks/<id>/output` live under
  // `/api/sessions/` and would otherwise be rejected before they are matched.
  createTaskRoutes(),
  // And again: `/input` is under `/api/sessions/` too.
  createCliInputRoutes(),
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
  // Same reason again: `/summary` lives under `/api/sessions/`.
  createSummaryRoutes(resolveBackend, describeAgentSession),
  // And `/events/<n>/blocks/<b>/image`, the picture behind an image block.
  createEventImageRoutes(),
  // Not under `/api/sessions/` at all -- usage is a fact about the machine -- so its position
  // here is only for readability.
  createUsageRoutes(usageScanner),
  // The rate-limit meters on their own, for the surfaces that want the meter without the sweep
  // behind it. Given the same scanner so Codex's meter comes from whatever the last sweep read.
  createLimitsRoutes(usageScanner),
  createParkRoutes(),
  // Desktop and window reads through the standalone helper. Not under `/api/sessions/`, so its
  // position here is only for readability.
  createWindowRoutes(),
  createWebrtcTileRoutes(),
  // The workspace IDE. Ahead of the session routes only for readability; none of these paths is
  // under `/api/sessions/`. The stream is listed before the others so `/stream` is matched before
  // the roster routes walk the same `/api/workspace/<id>/` shape.
  createWorkspaceStreamRoutes(workspaceService),
  createWorkspaceFileRoutes(workspaceService, {
    maxTextBytes: config.workspaceMaxTextBytes,
    maxDocumentBytes: config.workspaceMaxDocumentBytes,
  }),
  createWorkspaceHistoryRoutes(workspaceService),
  createWorkspaceRoutes(workspaceService),
  createSessionRoutes(describeAgentSession),
  // The relay as a URL instead of a file path: Streamable HTTP MCP on /mcp.
  // Top level path, so position is readability only.
  createRelayMcpHttpRoutes(),
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
    // token to mint, plumb, or type in to add a session.
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
        // Whether a machine terminal can be a PTY session here, read per request like
        // `usageVendors`: the socket is there while the host runs the PTY manager, and a peer runs
        // the sidecar without that host, so its answer is tmux.
        machineShell: existsSync(config.ptyManagerSocketPath) ? "pty" : "tmux",
        // Read per request, from the file this machine's supervisor heartbeats. It belongs on this
        // answer because the panel's dev server already asks every sidecar it knows for
        // `/api/config` on a timer to see whether it is alive, so a peer's held state crosses the
        // link with no request of its own -- and a peer is exactly the case a file cannot serve,
        // since the panel is on a different machine.
        supervisor: readSupervisorDescriptor(),
      };
      return jsonResponse(body);
    }
    for (const route of routes) {
      const response = route(request, url, bunServer);
      if (response !== undefined) return response;
    }
    return new Response("not found", {
      status: 404,
    });
  },
});

console.log(`agent feed sidecar listening on http://${config.host}:${server.port}`);
// Announce on the shared board so any panel on the machine can offer this session with no port
// hand-fed to it. Withdrawn in shutdown; a crash leaves a descriptor that ages out on its own.
const announcement = announceSidecar(config.port);
void startCatalog()
  .then(async () => {
    await claudeLive.start();
    await codexLive.start();
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
