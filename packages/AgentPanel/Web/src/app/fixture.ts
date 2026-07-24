/**
 * Host-free fixture for the WKWebView bridge.
 *
 * Every visibility watch echoes its generated subscription ID. This keeps the
 * fixture on the same replacement-snapshot contract as the native host.
 */

type Source = "claude" | "codex";

const PROJECT_PATH = "/Users/dev/projects/agent-desk";

export const FIXTURE_PROJECTS = [
  {
    pp: PROJECT_PATH,
    dn: "AgentDesk",
    sc: { cl: 1, co: 1 },
    sn: 2,
    lea: Date.now() - 60_000,
  },
  {
    pp: "/Users/dev/projects/research-tool",
    dn: "Research Tool",
    sc: { cl: 0, co: 2 },
    sn: 2,
    lea: Date.now() - 900_000,
  },
];

export const FIXTURE_SESSIONS = [
  {
    sid: "session-claude-001",
    src: "claude" as const,
    ttl: "Implement webview Vite bundle",
    lea: Date.now() - 60_000,
    ac: "live" as const,
  },
  {
    sid: "session-codex-001",
    src: "codex" as const,
    ttl: "Fix TypeScript errors in BridgeDataSource",
    lea: Date.now() - 300_000,
    ac: "ready" as const,
  },
];

function makeFixtureSeedChunk(source: Source, sessionId: string) {
  return {
    t: "agent-thread-chunk",
    src: source,
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
            tx: "I’ll set up the Vite toolchain and create the webview app.",
          },
          {
            k: "tool_use" as const,
            tl: "Write",
            ci: "call-001",
            sm: "vite.webview.config.ts",
          },
        ],
      },
    ],
    ws: 0,
    tot: 3,
    lv: false,
  };
}

function makeFixtureLiveChunk(source: Source, sessionId: string) {
  return {
    t: "agent-thread-chunk",
    src: source,
    sid: sessionId,
    ev: [
      {
        i: 2,
        ts: Date.now(),
        tp: "assistant" as const,
        b: [
          {
            k: "text" as const,
            tx: "The layered webview contract is connected.",
          },
        ],
      },
    ],
    ws: 0,
    tot: 3,
    lv: true,
  };
}

export function installFixture(): void {
  (window as Window & {
    webkit: {
      messageHandlers: {
        agentFeed: { postMessage: (message: unknown) => void };
      };
    };
  }).webkit = {
    messageHandlers: {
      agentFeed: {
        postMessage: (message: unknown) => {
          const value = message as {
            t?: string;
            sub?: string;
            pp?: string;
            src?: Source;
            sid?: string;
          };
          switch (value.t) {
            case "agent-projects-watch":
              if (!value.sub) return;
              setTimeout(() => {
                window.__agentFeedDeliver?.({
                  t: "agent-projects",
                  sub: value.sub,
                  p: FIXTURE_PROJECTS,
                });
              }, 30);
              break;
            case "agent-project-sessions-watch":
              if (!value.sub || !value.pp) return;
              setTimeout(() => {
                window.__agentFeedDeliver?.({
                  t: "agent-project-sessions",
                  sub: value.sub,
                  pp: value.pp,
                  ss: value.pp === PROJECT_PATH ? FIXTURE_SESSIONS : [],
                });
              }, 30);
              break;
            case "agent-thread-sub":
              if (!value.src || !value.sid) return;
              setTimeout(() => {
                window.__agentFeedDeliver?.(
                  makeFixtureSeedChunk(value.src!, value.sid!),
                );
                setTimeout(() => {
                  window.__agentFeedDeliver?.(
                    makeFixtureLiveChunk(value.src!, value.sid!),
                  );
                }, 80);
              }, 40);
              break;
          }
        },
      },
    },
  };
}
