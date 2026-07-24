/**
 * Fixture data for host-free development/verification.
 *
 * Call installFixture() before mounting the app when window.__agentFeedFixture
 * is true or the ?fixture query param is present. It wires a shim on
 * window.webkit so the WebkitHostBridge's outbound postMessage calls are
 * intercepted and canned inbound messages are injected in response.
 *
 * Delivery path:
 *   1. bridge.subscribeProjects -> posts "agent-projects-sub" outbound.
 *      Shim intercepts -> delivers FIXTURE_PROJECTS_MSG inbound.
 *   2. User taps a session -> bridge.subscribeSessionEvents -> posts
 *      "agent-thread-sub" outbound.
 *      Shim intercepts -> delivers seed chunk (isLive:false) then a live
 *      chunk (isLive:true).
 */

// Abbreviated wire keys, matching SharedTypes.swift (the host emits these and
// the native client forwards them verbatim). See BridgeDataSource.ts wire layer.
export const FIXTURE_PROJECTS_MSG = {
  t: "agent-projects",
  p: [
    {
      pp: "/Users/dev/projects/agent-desk",
      dn: "AgentDesk",
      ss: [
        {
          sid: "session-claude-001",
          src: "claude" as const,
          ttl: "Implement webview Vite bundle",
          lea: Date.now() - 60_000,
          lv: true,
        },
        {
          sid: "session-codex-001",
          src: "codex" as const,
          ttl: "Fix TypeScript errors in BridgeDataSource",
          lea: Date.now() - 300_000,
          lv: false,
        },
      ],
    },
    {
      pp: "/Users/dev/projects/agent-desk",
      dn: "Agent Desk (iOS Client)",
      ss: [
        {
          sid: "session-claude-002",
          src: "claude" as const,
          ttl: "Add phone webview app",
          lea: Date.now() - 120_000,
          lv: false,
        },
      ],
    },
    {
      pp: "/Users/dev/projects/research-tool",
      dn: "Research Tool",
      ss: [
        {
          sid: "session-codex-002",
          src: "codex" as const,
          ttl: "Refactor data pipeline",
          lea: Date.now() - 900_000,
          lv: false,
        },
        {
          sid: "session-codex-003",
          src: "codex" as const,
          ttl: "Add unit tests",
          lea: Date.now() - 3_600_000,
          lv: false,
        },
      ],
    },
  ],
};

const FIXTURE_SESSION_IDS = new Set(
  FIXTURE_PROJECTS_MSG.p.flatMap((p) => p.ss.map((s) => s.sid)),
);

/** Seed chunk for a session: historical events (isLive: false). */
export function makeFixtureSeedChunk(sessionId: string) {
  return {
    t: "agent-thread-chunk",
    sid: sessionId,
    ev: [
      {
        i: 0,
        ts: Date.now() - 200_000,
        tp: "user" as const,
        b: [
          {
            k: "text" as const,
            tx: "Please implement the webview Vite bundle for the iPhone surface.",
          },
        ],
      },
      {
        i: 1,
        ts: Date.now() - 195_000,
        tp: "assistant" as const,
        b: [
          {
            k: "text" as const,
            tx: "I'll set up the Vite toolchain and create the webview app. Starting with the config files.",
          },
          {
            k: "tool_use" as const,
            tl: "Write",
            ci: "call-001",
            sm: "vite.webview.config.ts",
          },
        ],
      },
      {
        i: 2,
        ts: Date.now() - 190_000,
        tp: "user" as const,
        b: [
          {
            k: "tool_result" as const,
            ci: "call-001",
            pv: "File written successfully.",
          },
        ],
      },
    ],
    ws: 0,
    tot: 4,
    lv: false,
  };
}

/** Live event delivered after the seed chunk. */
export function makeFixtureLiveChunk(sessionId: string) {
  return {
    t: "agent-thread-chunk",
    sid: sessionId,
    ev: [
      {
        i: 3,
        ts: Date.now(),
        tp: "assistant" as const,
        b: [
          {
            k: "text" as const,
            tx: "All files created. Running the build now to verify asset paths are relative.",
          },
        ],
      },
    ],
    ws: 0,
    tot: 4,
    lv: true,
  };
}

/**
 * Install the fixture shim. Call once before mounting the app.
 *
 * Installs a window.webkit shim that intercepts outbound messages from the
 * WebkitHostBridge and delivers canned inbound messages via
 * window.__agentFeedDeliver.
 */
export function installFixture(): void {
  // Install a shim on window.webkit.messageHandlers.agentFeed so the
  // WebkitHostBridge's postToHost calls are intercepted.
  (window as Window & {
    webkit: {
      messageHandlers: {
        agentFeed: { postMessage: (msg: unknown) => void };
      };
    };
  }).webkit = {
    messageHandlers: {
      agentFeed: {
        postMessage: (msg: unknown) => {
          const m = msg as { t?: string; sid?: string };
          switch (m.t) {
            case "agent-projects-sub":
              // Deliver the project list after a short delay so the bridge's
              // global __agentFeedDeliver function is installed first.
              setTimeout(() => {
                window.__agentFeedDeliver?.(FIXTURE_PROJECTS_MSG);
              }, 30);
              break;
            case "agent-thread-sub":
              if (m.sid && FIXTURE_SESSION_IDS.has(m.sid)) {
                const sid = m.sid;
                setTimeout(() => {
                  window.__agentFeedDeliver?.(makeFixtureSeedChunk(sid));
                  setTimeout(() => {
                    window.__agentFeedDeliver?.(makeFixtureLiveChunk(sid));
                  }, 80);
                }, 40);
              }
              break;
            default:
              // Other outbound messages (agent-thread-unsub, etc.) are ignored.
              break;
          }
        },
      },
    },
  };
}
