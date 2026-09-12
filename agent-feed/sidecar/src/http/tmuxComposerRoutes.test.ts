import { expect, test } from "bun:test";
import type { TmuxComposerState } from "@agentdesk/agent-feed-wire";
import {
  createTmuxComposerRoutes,
  type TmuxComposerDependencies,
} from "./tmuxComposerRoutes.ts";

const SESSION = "2adc3708-fadb-4e2f-a744-322df224faf4";
const server = { timeout() {} } as never;

const HOLDING: TmuxComposerState = { text: "hello", hint: null, reason: null, wrapped: false };

function routeWith(overrides: Partial<TmuxComposerDependencies> = {}) {
  const synced: string[] = [];
  const submitted: string[] = [];
  const watched: string[] = [];
  const accepted: string[] = [];
  const composer: TmuxComposerDependencies = {
    observe: (sessionId, listener) => {
      watched.push(sessionId);
      listener.onState(HOLDING);
      return () => watched.push(`stop:${sessionId}`);
    },
    sync: async (_sessionId, text) => {
      synced.push(text);
      return { text, hint: null, reason: null, wrapped: false };
    },
    submit: async (sessionId) => {
      submitted.push(sessionId);
      return { text: "", hint: null, reason: null, wrapped: false };
    },
    accept: async (sessionId) => {
      accepted.push(sessionId);
      return { text: null, hint: null, reason: null, wrapped: false };
    },
    ...overrides,
  };
  return { route: createTmuxComposerRoutes(composer), synced, submitted, watched, accepted };
}

function call(
  route: ReturnType<typeof createTmuxComposerRoutes>,
  method: string,
  path: string,
  body?: unknown,
) {
  const url = new URL(`http://127.0.0.1${path}`);
  const request = new Request(url.toString(), {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return route(request, url, server);
}

test("reading is a stream, and there is no request form of it", async () => {
  // Deliberately absent rather than merely unused: a one-shot read is what a poll is made of, and
  // leaving one here would be an invitation to go back to asking on a timer.
  const { route, watched, synced, submitted } = routeWith();
  expect(await call(route, "GET", `/api/sessions/claude/${SESSION}/composer`)).toBeUndefined();

  const response = await call(route, "GET", `/api/sessions/claude/${SESSION}/composer/stream`);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("content-type")).toContain("text/event-stream");
  expect(watched).toEqual([SESSION]);
  expect(synced).toEqual([]);
  expect(submitted).toEqual([]);
});

test("codex is refused by the pattern, because the box this reads is Claude's", async () => {
  const { route } = routeWith();
  expect(await call(route, "GET", `/api/sessions/codex/${SESSION}/composer/stream`))
    .toBeUndefined();
});

test("a push carries the whole desired text, not the keystrokes", async () => {
  const { route, synced } = routeWith();
  const response = await call(
    route,
    "POST",
    `/api/sessions/claude/${SESSION}/composer`,
    { text: "make the hover ring stronger" },
  );
  expect(response?.status).toBe(200);
  expect(synced).toEqual(["make the hover ring stronger"]);
});

test("an empty push is an instruction to clear, not a malformed request", async () => {
  // The one place this differs from the inbox next door: there a blank turn is refused because
  // delivering it costs a model call, here it is what emptying the field means.
  const { route, synced } = routeWith();
  const response = await call(
    route, "POST", `/api/sessions/claude/${SESSION}/composer`, { text: "" },
  );
  expect(response?.status).toBe(200);
  expect(synced).toEqual([""]);
});

test("a missing or oversized text is the caller's fault, and says so with a status", async () => {
  const { route, synced } = routeWith();
  expect((await call(route, "POST", `/api/sessions/claude/${SESSION}/composer`, {}))?.status)
    .toBe(400);
  const huge = { text: "x".repeat(16 * 1024 + 1) };
  expect((await call(route, "POST", `/api/sessions/claude/${SESSION}/composer`, huge))?.status)
    .toBe(413);
  expect(synced).toEqual([]);
});

test("the stream only takes a GET, and submit only a POST", async () => {
  const { route } = routeWith();
  expect(await call(route, "POST", `/api/sessions/claude/${SESSION}/composer/stream`, {}))
    .toBeUndefined();
  expect(await call(route, "GET", `/api/sessions/claude/${SESSION}/composer/submit`))
    .toBeUndefined();
});

test("a session with no pane answers 200 with the reason, not an error status", async () => {
  // The panel renders this beside the field. A 4xx would be indistinguishable from a request it
  // got wrong, which is a different thing to tell the reader.
  const { route } = routeWith({
    sync: async () => ({ text: null, hint: null, reason: "no-pane", wrapped: false }),
  });
  const response = await call(
    route, "POST", `/api/sessions/claude/${SESSION}/composer`, { text: "hello" },
  );
  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({ text: null, hint: null, reason: "no-pane", wrapped: false });
});

test("submitting is its own address, and so is accepting the hint", async () => {
  const { route, submitted, accepted } = routeWith();
  const submitResponse = await call(
    route, "POST", `/api/sessions/claude/${SESSION}/composer/submit`,
  );
  expect(submitResponse?.status).toBe(200);
  expect(submitted).toEqual([SESSION]);

  // Its own address rather than a flag on submit, because the two press different keys at a
  // session somebody else is watching, and one of them takes their turn.
  const acceptResponse = await call(
    route, "POST", `/api/sessions/claude/${SESSION}/composer/accept`,
  );
  expect(acceptResponse?.status).toBe(200);
  expect(accepted).toEqual([SESSION]);
  expect(submitted).toEqual([SESSION]);
});
