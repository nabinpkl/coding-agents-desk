import { expect, test } from "bun:test";
import type { AgentBackend } from "@/agents/agentBackend";
import { createOpencodeRoutes } from "@/http/agent-routes/opencodeRoutes";

function fakeBackend(): AgentBackend {
  return {
    id: "pi",
    capabilities: {
      modes: ["nice"],
      canSend: true,
      canSteer: true,
      canAbort: true,
      canFetchRaw: false,
      canOpenTerminal: false,
      supportsExtensionUi: true,
      canStreamLive: false,
    },
    describeSession() {
      return undefined;
    },
    async createSession() {
      throw new Error("not used");
    },
    async page() {
      return { events: [], total: 0, mode: "nice", sequence: 0, runState: "idle", queue: { steer: 0, followUp: 0 } };
    },
    async subscribe() {
      return () => {};
    },
    async send(sessionId, requestId, _text, delivery) {
      return { requestId, delivery: delivery === "steer" ? "steer" : "immediate" };
    },
    async abort(_sessionId, requestId) {
      return { requestId, delivery: "abort" };
    },
    async subscribeUi() {
      return () => {};
    },
    async respondToUi() {
      return "accepted";
    },
    async dispose() {},
  };
}

const server = { timeout() {} } as never;

test("opencode commands list from the backend and run with the draft as arguments", async () => {
  const ran: { sessionId: string; name: string; text: string }[] = [];
  const base = fakeBackend();
  const route = createOpencodeRoutes((id) =>
    id === "opencode"
      ? {
          ...base,
          id: "opencode",
          listCommands: async () => [{ name: "review", description: "review changes" }],
          runCommand: async (sessionId: string, requestId: string, name: string, text: string) => {
            ran.push({ sessionId, name, text });
            return { requestId, delivery: "followUp" as const };
          },
        }
      : undefined,
  );

  const list = new Request("http://localhost/api/agent-sessions/opencode/commands", { method: "GET" });
  const listed = await route(list, new URL(list.url), server);
  expect(listed?.status).toBe(200);
  // The route publishes the backend's list verbatim; merging locals is the backend's job.
  expect(await listed?.json()).toEqual({ commands: [{ name: "review", description: "review changes" }] });

  const run = new Request("http://localhost/api/agent-sessions/opencode/s1/command", {
    method: "POST",
    body: JSON.stringify({ requestId: "c1", name: "review", text: "the last commit" }),
  });
  const answered = await route(run, new URL(run.url), server);
  expect(answered?.status).toBe(202);
  expect(await answered?.json()).toEqual({ requestId: "c1", delivery: "followUp" });
  expect(ran).toEqual([{ sessionId: "s1", name: "review", text: "the last commit" }]);

  const local = new Request("http://localhost/api/agent-sessions/opencode/s1/command", {
    method: "POST",
    body: JSON.stringify({ requestId: "c-local", name: "compact", text: "" }),
  });
  const localAnswered = await route(local, new URL(local.url), server);
  expect(localAnswered?.status).toBe(202);
  // Local names travel the same run route: the backend sorts them natively.
  expect(ran.at(-1)).toEqual({ sessionId: "s1", name: "compact", text: "" });

  const nameless = new Request("http://localhost/api/agent-sessions/opencode/s1/command", {
    method: "POST",
    body: JSON.stringify({ requestId: "c2", text: "the last commit" }),
  });
  expect((await route(nameless, new URL(nameless.url), server))?.status).toBe(400);
});

test("a command receipt carries the session a fork made, which is how the panel opens it", async () => {
  const base = fakeBackend();
  const descriptor = {
    sessionId: "ses_fork",
    source: "opencode",
    projectPath: "/tmp/project",
    title: "Fork",
    lastEventAt: 1,
    activity: "ready" as const,
    capabilities: base.capabilities,
  };
  const route = createOpencodeRoutes((id) =>
    id === "opencode"
      ? {
          ...base,
          id: "opencode",
          runCommand: async (_sessionId: string, requestId: string) => ({
            requestId,
            delivery: "immediate" as const,
            session: descriptor,
          }),
        }
      : undefined,
  );

  const run = new Request("http://localhost/api/agent-sessions/opencode/s1/command", {
    method: "POST",
    body: JSON.stringify({ requestId: "f1", name: "fork", text: "" }),
  });
  const answered = await route(run, new URL(run.url), server);
  expect(answered?.status).toBe(202);
  expect(await answered?.json()).toEqual({ requestId: "f1", delivery: "immediate", session: descriptor });
});

test("opencode command routes answer 404 without the backend", async () => {
  const route = createOpencodeRoutes(() => undefined);
  const list = new Request("http://localhost/api/agent-sessions/opencode/commands", { method: "GET" });
  expect((await route(list, new URL(list.url), server))?.status).toBe(404);
  const run = new Request("http://localhost/api/agent-sessions/opencode/s1/command", {
    method: "POST",
    body: JSON.stringify({ requestId: "c1", name: "review", text: "" }),
  });
  expect((await route(run, new URL(run.url), server))?.status).toBe(404);
  const aside = new Request("http://localhost/api/agent-sessions/opencode/s1/aside", {
    method: "POST",
    body: JSON.stringify({ question: "what did we decide?" }),
  });
  expect((await route(aside, new URL(aside.url), server))?.status).toBe(404);
  const exported = new Request("http://localhost/api/agent-sessions/opencode/s1/export", { method: "GET" });
  expect((await route(exported, new URL(exported.url), server))?.status).toBe(404);
});

test("opencode models list and switch through the backend", async () => {
  const switched: { sessionId: string; providerID: string; modelID: string }[] = [];
  const base = fakeBackend();
  const route = createOpencodeRoutes((id) =>
    id === "opencode"
      ? {
          ...base,
          id: "opencode",
          listModels: async () => [
            { providerID: "p", modelID: "m", name: "M", contextLimit: 1000, inputCost: 1, outputCost: 2 },
          ],
          switchModel: async (sessionId: string, requestId: string, providerID: string, modelID: string) => {
            switched.push({ sessionId, providerID, modelID });
            return { requestId, delivery: "followUp" as const };
          },
        }
      : undefined,
  );

  const list = new Request("http://localhost/api/agent-sessions/opencode/models", { method: "GET" });
  const listed = await route(list, new URL(list.url), server);
  expect(listed?.status).toBe(200);
  expect(await listed?.json()).toEqual({
    models: [{ providerID: "p", modelID: "m", name: "M", contextLimit: 1000, inputCost: 1, outputCost: 2 }],
  });

  const run = new Request("http://localhost/api/agent-sessions/opencode/s1/model", {
    method: "POST",
    body: JSON.stringify({ requestId: "m1", providerID: "p", modelID: "m" }),
  });
  const answered = await route(run, new URL(run.url), server);
  expect(answered?.status).toBe(202);
  expect(switched).toEqual([{ sessionId: "s1", providerID: "p", modelID: "m" }]);

  const missing = new Request("http://localhost/api/agent-sessions/opencode/s1/model", {
    method: "POST",
    body: JSON.stringify({ requestId: "m2", providerID: "p" }),
  });
  expect((await route(missing, new URL(missing.url), server))?.status).toBe(400);
});

test("an aside answers with text and refuses a blank question", async () => {
  const asked: { sessionId: string; question: string }[] = [];
  const base = fakeBackend();
  const route = createOpencodeRoutes((id) =>
    id === "opencode"
      ? {
          ...base,
          id: "opencode",
          askAside: async (sessionId: string, question: string) => {
            asked.push({ sessionId, question });
            return "we chose the sidecar";
          },
        }
      : undefined,
  );

  const ask = new Request("http://localhost/api/agent-sessions/opencode/s1/aside", {
    method: "POST",
    body: JSON.stringify({ question: "  what did we decide?  " }),
  });
  const answered = await route(ask, new URL(ask.url), server);
  expect(answered?.status).toBe(200);
  expect(await answered?.json()).toEqual({ text: "we chose the sidecar" });
  expect(asked).toEqual([{ sessionId: "s1", question: "what did we decide?" }]);

  const blank = new Request("http://localhost/api/agent-sessions/opencode/s1/aside", {
    method: "POST",
    body: JSON.stringify({ question: "   " }),
  });
  expect((await route(blank, new URL(blank.url), server))?.status).toBe(400);
});

test("an export answers with the transcript the backend read", async () => {
  const base = fakeBackend();
  const route = createOpencodeRoutes((id) =>
    id === "opencode"
      ? {
          ...base,
          id: "opencode",
          exportTranscript: async (sessionId: string) => ({ info: { id: sessionId }, messages: [] }),
        }
      : undefined,
  );

  const request = new Request("http://localhost/api/agent-sessions/opencode/s1/export", { method: "GET" });
  const answered = await route(request, new URL(request.url), server);
  expect(answered?.status).toBe(200);
  expect(await answered?.json()).toEqual({ transcript: { info: { id: "s1" }, messages: [] } });
});

test("a title answers with the name the session now has, and a blank one is refused", async () => {
  const renamed: { sessionId: string; title: string }[] = [];
  const base = fakeBackend();
  const route = createOpencodeRoutes((id) =>
    id === "opencode"
      ? {
          ...base,
          id: "opencode",
          renameSession: async (sessionId: string, title: string) => {
            renamed.push({ sessionId, title });
          },
        }
      : undefined,
  );

  const request = new Request("http://localhost/api/agent-sessions/opencode/s1/title", {
    method: "POST",
    body: JSON.stringify({ title: "  Called it this  " }),
  });
  const answered = await route(request, new URL(request.url), server);
  expect(answered?.status).toBe(200);
  // Trimmed, and answered with the stored name rather than the one that was typed: the serve is
  // the record, so this is what a caller shows to say what it got.
  expect(await answered?.json()).toEqual({ sessionId: "s1", title: "Called it this" });
  expect(renamed).toEqual([{ sessionId: "s1", title: "Called it this" }]);

  const blank = new Request("http://localhost/api/agent-sessions/opencode/s1/title", {
    method: "POST",
    body: JSON.stringify({ title: "   " }),
  });
  expect((await route(blank, new URL(blank.url), server))?.status).toBe(400);
  expect(renamed).toHaveLength(1);
});

test("the title route answers 404 without the backend, like the rest of the opencode surface", async () => {
  const route = createOpencodeRoutes(() => undefined);
  const request = new Request("http://localhost/api/agent-sessions/opencode/s1/title", {
    method: "POST",
    body: JSON.stringify({ title: "Called it this" }),
  });
  expect((await route(request, new URL(request.url), server))?.status).toBe(404);
});
