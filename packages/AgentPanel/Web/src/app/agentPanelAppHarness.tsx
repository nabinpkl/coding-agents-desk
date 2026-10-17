/**
 * The fakes and fixtures every App-shell test file runs against.
 *
 * The `vi.mock` calls stay in each test file, because Vitest hoists them per file; what lives
 * here is the module each of those factories returns, plus the fixtures and the render helper.
 *
 * The App has two collaborators and these tests drive both: a FakeHttpTransport standing in for
 * the sidecar behind `feed`, and a FakeHostBridge standing in for the Mac's native authority
 * behind `host`. Keeping them apart in the test is the point -- a shell behaviour that reached
 * the wrong one would pass against a single merged fake.
 *
 * ActivityFeed is mocked (it's a heavy virtualized component that depends on
 * ProseMirror/Milkdown), so the signal that the data layer wired up correctly is that the feed
 * mounted against the selected thread.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { BotSnapshot, BotView, SetBotCanvasCommand } from "@agentdesk/agent-feed-wire";
import { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import { HostActionsClient } from "@/features/activity-feed/data-source/HostActionsClient";
import { FakeHostBridge } from "@/features/activity-feed/data-source/HostBridge";
import { FakeHttpTransport } from "@/features/activity-feed/transport/FakeHttpTransport";
import { App } from "@/app/AgentPanelApp";
import { feedMock, terminalPaneMock } from "@/app/agentPanelAppMocks";

// ---------------------------------------------------------------------------
// Fixture project data
// ---------------------------------------------------------------------------

// The sidecar's own shapes, unabbreviated. There is no rename layer between here and the panel
// any more, so a fixture that drifts from the sidecar fails rather than being translated.
export const FIXTURE_PROJECT_A = {
  projectPath: "/projects/alpha",
  displayName: "Alpha Project",
  sourceCounts: { claude: 1, codex: 1 },
  sessionCount: 2,
  lastEventAt: Date.now() - 10_000,
};

export const FIXTURE_PROJECT_B = {
  projectPath: "/projects/beta",
  displayName: "Beta Project",
  sourceCounts: { claude: 1, codex: 0 },
  sessionCount: 1,
  lastEventAt: Date.now() - 5_000,
};

export const FIXTURE_PROJECTS = [FIXTURE_PROJECT_A, FIXTURE_PROJECT_B];
export const READ_ONLY_CAPABILITIES = {
  modes: ["raw", "nice"],
  canSend: false,
  canSteer: false,
  canAbort: false,
  canFetchRaw: true,
  canOpenTerminal: true,
  supportsExtensionUi: false,
  canStreamLive: false,
};
export const FIXTURE_SESSIONS = [
  {
    sessionId: "sid-claude-01",
    source: "claude" as const,
    title: "Session Claude 01",
    lastEventAt: Date.now() - 10_000,
    activity: "live" as const,
    capabilities: READ_ONLY_CAPABILITIES,
  },
  {
    sessionId: "sid-codex-01",
    source: "codex" as const,
    title: "Session Codex 01",
    lastEventAt: Date.now() - 60_000,
    activity: "ready" as const,
    capabilities: READ_ONLY_CAPABILITIES,
  },
];

/** One Bot holding the fixture's first session, which is what a fork branches from. */
export const BOT_WITH_ONE_SESSION = {
          botId: "bot-1",
          name: "Release Captain",
          environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
          sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
          sessionAnchors: { "claude:sid-claude-01": "Aaron" },
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [FIXTURE_SESSIONS[0]!],
          missingSessionRefs: [],
          nextAnchor: "Adam",
        };

export const originalMatchMedia = globalThis.matchMedia;

export function installViewport({
  compact,
  hoverCapable,
}: {
  compact: boolean;
  hoverCapable: boolean;
}) {
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    value: (queryText: string) => ({
      matches: queryText.includes("max-width") ? compact : hoverCapable,
      media: queryText,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }) as MediaQueryList,
  });
}

export function restoreViewport() {
  if (originalMatchMedia) {
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  } else {
    Reflect.deleteProperty(globalThis, "matchMedia");
  }
}

export function firePointerEvent(
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  { pointerId, clientX }: { pointerId: number; clientX: number },
) {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  fireEvent(element, event);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** `terminalIds` hands out request ids in order, for the tests that need to tell two apart. */
export function setup(terminalIds: string[] = []) {
  const fake = new FakeHostBridge();
  const transport = new FakeHttpTransport();
  const pending = [...terminalIds];
  let sequence = 0;
  const host = new HostActionsClient(fake, {
    requestIDFactory: (prefix) =>
      prefix === "terminal"
        ? pending.shift() ?? "request-1"
        : `${prefix}-${++sequence}`,
  });
  const bots = holdBotCanvas(transport);
  const { unmount } = render(<App feed={new SidecarDataSource(transport)} host={host} />);
  act(() => {
    transport.deliver("/api/bots/stream", { version: 2, revision: 0, bots: [] });
  });
  return { fake, transport, host, unmount, bots };
}

/**
 * Makes the fake sidecar keep the canvas the way the real one does: on the Bot records.
 *
 * Remembers the last Bot snapshot delivered, and answers `PATCH /api/bots/:id/canvas` by applying
 * the command to it and publishing the new snapshot down the stream, as `botCanvas.ts` does.
 * Synchronously, inside the request, so a click and the canvas it changes land in one `act`.
 * `latest()` is what a reload would be sent.
 */
function holdBotCanvas(transport: FakeHttpTransport): { latest: () => BotSnapshot | null } {
  let latest: BotSnapshot | null = null;
  const deliver = transport.deliver.bind(transport);
  transport.deliver = (match, payload) => {
    if (match === "/api/bots/stream" && typeof payload === "object") latest = payload as BotSnapshot;
    deliver(match, payload);
  };
  const request = transport.request.bind(transport);
  transport.request = (method, path, options = {}) => {
    const canvas = /^\/api\/bots\/([^/]+)\/canvas$/.exec(path);
    if (method !== "PATCH" || !canvas || !latest) return request(method, path, options);
    const botId = decodeURIComponent(canvas[1]!);
    const command = options.body as SetBotCanvasCommand;
    const bots = latest.bots.map((bot) => bot.botId === botId ? applyCanvas(bot, command) : bot);
    transport.deliver("/api/bots/stream", { ...latest, revision: latest.revision + 1, bots });
    const answered = request(method, path, options);
    return answered.then(() => ({
      status: 200,
      body: JSON.stringify(bots.find((bot) => bot.botId === botId)),
    }));
  };
  return { latest: () => latest };
}

function applyCanvas(bot: BotView, command: SetBotCanvasCommand): BotView {
  const key = (ref: { source: string; sessionId: string }) => `${ref.source}:${ref.sessionId}`;
  const off = new Set((bot.offCanvasSessionRefs ?? []).map(key));
  for (const change of command.sessions ?? []) {
    if (change.onCanvas) off.delete(key(change));
    else off.add(key(change));
  }
  const { offCanvas, offCanvasSessionRefs: _refs, ...rest } = bot;
  const refs = bot.sessionRefs.filter((ref) => off.has(key(ref)));
  const stillOff = command.onCanvas === undefined ? offCanvas : !command.onCanvas;
  return {
    ...rest,
    ...(stillOff ? { offCanvas: true } : {}),
    ...(refs.length > 0 ? { offCanvasSessionRefs: refs } : {}),
    ...(command.position === undefined ? {} : { canvasPosition: command.position }),
  };
}

/** The newest subscription id the App posted for a native-authority watch. */
/** Claude's composer and question stream. One path, because the sidecar sends both down it. */
export const COMPOSER_STREAM = "/api/window/composer/stream";

export function latestSubscription(fake: FakeHostBridge, type: string): string {
  const message = [...fake.posted]
    .reverse()
    .find((candidate) => (candidate as { t?: string }).t === type) as
    | { sub?: string }
    | undefined;
  if (!message?.sub) throw new Error(`missing ${type}`);
  return message.sub;
}

export function deliverProjects(transport: FakeHttpTransport) {
  act(() => {
    transport.deliver("/api/inventory/stream", { projects: FIXTURE_PROJECTS });
  });
}

export function deliverSessions(transport: FakeHttpTransport) {
  deliverProjectSessions(transport, FIXTURE_PROJECT_A.projectPath, FIXTURE_SESSIONS);
}

export function deliverProjectSessions(
  transport: FakeHttpTransport,
  projectPath: string,
  sessions: typeof FIXTURE_SESSIONS | Array<Record<string, unknown>>,
) {
  act(() => {
    transport.deliver(`projectPath=${encodeURIComponent(projectPath)}`, { projectPath, sessions });
  });
}

export const PI_SESSION = {
  sessionId: "pi-1",
  source: "pi",
  projectPath: FIXTURE_PROJECT_A.projectPath,
  title: "SDK-authored Pi session",
  lastEventAt: 123,
  activity: "ready",
  capabilities: {
    modes: ["nice"],
    canSend: true,
    canSteer: true,
    canAbort: true,
    canFetchRaw: false,
    canOpenTerminal: false,
    supportsExtensionUi: true,
    canStreamLive: true,
  },
};

/** Clicks New Pi session and lets the sidecar answer with the descriptor the panel then opens. */
export async function createPiSession(transport: FakeHttpTransport) {
  transport.responses.set("POST /api/agent-sessions", {
    status: 201,
    body: JSON.stringify(PI_SESSION),
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "New Pi session in Alpha Project" }));
  });
}

export function openClaudeThread(transport: FakeHttpTransport) {
  deliverProjects(transport);
  deliverSessions(transport);
  fireEvent.click(screen.getByText("Session Claude 01"));
}

export function emitTerminalState(state: Record<string, unknown>) {
  const context = terminalPaneMock.context;
  const onState = terminalPaneMock.onState;
  if (!context || !onState) throw new Error("terminal pane is not mounted");
  act(() => onState(context, state));
}

/** Both Bots on the canvas, each with one session, which is the shape the multi-session bugs need. */
export function deliverTwoBots(transport: FakeHttpTransport) {
  act(() => {
    transport.deliver("/api/bots/stream", {
      version: 2,
      revision: 1,
      bots: [
        {
          botId: "bot-1",
          name: "Release Captain",
          environment: { kind: "directory", path: FIXTURE_PROJECT_A.projectPath },
          sessionRefs: [{ source: "claude", sessionId: "sid-claude-01" }],
          metadata: { role: "Coordinates releases", labels: [], custom: {} },
          grants: [],
          createdAt: 1,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [FIXTURE_SESSIONS[0]!],
          missingSessionRefs: [],
          nextAnchor: "Adam",
        },
        {
          botId: "bot-2",
          name: "Docs Keeper",
          environment: { kind: "directory", path: FIXTURE_PROJECT_B.projectPath },
          sessionRefs: [{ source: "codex", sessionId: "sid-codex-01" }],
          metadata: { labels: [], custom: {} },
          grants: [],
          createdAt: 2,
          createdBy: { kind: "user" },
          environmentAvailability: "available",
          sessions: [FIXTURE_SESSIONS[1]!],
          missingSessionRefs: [],
          nextAnchor: "Adam",
        },
      ],
    });
  });
}

/** Puts one running task on that session, which is the only thing that offers its chip. */
export function deliverRunningTask(transport: FakeHttpTransport, sessionId: string) {
  act(() => {
    transport.deliver(`/${sessionId}/tasks`, {
      ownerAlive: true,
      ownerWaiting: false,
      finished: [],
      running: [{
        taskId: `task-${sessionId}`,
        kind: "bash",
        description: "Run the full test suite",
        command: "just check",
        startedAt: Date.now() - 1000,
        state: { status: "running" },
        elapsedMs: 1000,
        hasOutput: false,
        corroborated: true,
        activity: null,
      }],
    });
  });
}
