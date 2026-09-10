import { expect, test } from "bun:test";
import type { RailModifiers, TmuxComposerState } from "@agentdesk/agent-feed-wire";
import {
  createTmuxComposerRoutes,
  type TmuxComposerDependencies,
} from "@/http/session-routes/tmuxComposerRoutes";

const SESSION = "2adc3708-fadb-4e2f-a744-322df224faf4";
const server = { timeout() {} } as never;

const HOLDING: TmuxComposerState = { text: "hello", hint: null, reason: null, exact: true, commands: [] };

function routeWith(overrides: Partial<TmuxComposerDependencies> = {}) {
  const synced: string[] = [];
  const submitted: string[] = [];
  const watched: string[] = [];
  const accepted: string[] = [];
  const dropped: { bytes: number; mediaType: string }[] = [];
  const pressed: { key: string; modifiers: RailModifiers }[] = [];
  const composer: TmuxComposerDependencies = {
    observe: (sessionId, listener) => {
      watched.push(sessionId);
      listener.onState(HOLDING);
      return () => watched.push(`stop:${sessionId}`);
    },
    sync: async (_sessionId, text) => {
      synced.push(text);
      return { text, hint: null, reason: null, exact: true, commands: [] };
    },
    submit: async (sessionId) => {
      submitted.push(sessionId);
      return { text: "", hint: null, reason: null, exact: true, commands: [] };
    },
    accept: async (sessionId) => {
      accepted.push(sessionId);
      return { text: null, hint: null, reason: null, exact: true, commands: [] };
    },
    drop: async (_sessionId, image, mediaType) => {
      dropped.push({ bytes: image.length, mediaType });
      return { text: null, hint: null, reason: null, exact: true, commands: [] };
    },
    key: async (_sessionId, key, modifiers) => {
      pressed.push({ key, modifiers });
      return { text: null, hint: null, reason: null, exact: true, commands: [] };
    },
    ...overrides,
  };
  return {
    route: createTmuxComposerRoutes(composer),
    synced,
    submitted,
    watched,
    accepted,
    dropped,
    pressed,
  };
}

/** The smallest real PNG, so the sniff has something honest to identify. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478da6360000000020001" +
    "48afa4710000000049454e44ae426082",
  "hex",
);

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
    sync: async () => ({ text: null, hint: null, reason: "no-pane", exact: true, commands: [] }),
  });
  const response = await call(
    route, "POST", `/api/sessions/claude/${SESSION}/composer`, { text: "hello" },
  );
  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({ text: null, hint: null, reason: "no-pane", exact: true, commands: [] });
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

test("a dropped image is identified by its own bytes, not by what the caller called it", async () => {
  const { route, dropped } = routeWith();
  const response = await call(
    route,
    "POST",
    `/api/sessions/claude/${SESSION}/composer/image`,
    { data: PNG.toString("base64") },
  );
  expect(response?.status).toBe(200);
  expect(dropped).toEqual([{ bytes: PNG.length, mediaType: "image/png" }]);
});

test("something that is not an image is refused here, rather than in somebody's composer", async () => {
  // The failure this status exists to prevent is not an exception. A file written with a name
  // Claude accepts and content it then refuses lands in the pane as a literal file path, visible
  // to whoever is sitting in front of it.
  const { route, dropped } = routeWith();
  const response = await call(
    route,
    "POST",
    `/api/sessions/claude/${SESSION}/composer/image`,
    { data: Buffer.from("this is a text file, not a png").toString("base64") },
  );
  expect(response?.status).toBe(415);
  // In the envelope the panel's client actually reads: a bare string reaches the reader as
  // "sidecar answered 415", and a drop is an ordinary thing to get wrong.
  expect(await response!.json()).toMatchObject({
    error: { code: "image-unsupported", message: expect.stringContaining("png") },
  });
  expect(dropped).toEqual([]);
});

test("an oversized or missing image is the caller's fault, and says so with a status", async () => {
  const { route, dropped } = routeWith();
  const path = `/api/sessions/claude/${SESSION}/composer/image`;
  expect((await call(route, "POST", path, {}))?.status).toBe(400);
  // Decodes to nothing, which is all a base64 decoder can say about text that is not base64.
  expect((await call(route, "POST", path, { data: "!!!!" }))?.status).toBe(400);
  const huge = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]).toString("base64");
  expect((await call(route, "POST", path, { data: huge }))?.status).toBe(413);
  expect(dropped).toEqual([]);
});

test("dropping only takes a POST, and codex has no composer to drop into", async () => {
  const { route } = routeWith();
  expect(await call(route, "GET", `/api/sessions/claude/${SESSION}/composer/image`))
    .toBeUndefined();
  expect(await call(route, "POST", `/api/sessions/codex/${SESSION}/composer/image`, { data: "x" }))
    .toBeUndefined();
});

test("presses a named rail key, with only the modifiers that were actually held", async () => {
  const feed = routeWith();
  const response = await call(feed.route, "POST", `/api/sessions/claude/${SESSION}/composer/key`, {
    key: "left",
    modifiers: { ctrl: true, alt: false },
  });
  expect(response!.status).toBe(200);
  // The absent one is not held rather than undefined: a caller may send only what it is holding.
  expect(feed.pressed).toEqual([{ key: "left", modifiers: { ctrl: true, alt: false, shift: false } }]);
});

test("takes a key press with no modifiers at all", async () => {
  const feed = routeWith();
  await call(feed.route, "POST", `/api/sessions/claude/${SESSION}/composer/key`, { key: "escape" });
  expect(feed.pressed).toEqual([
    { key: "escape", modifiers: { ctrl: false, alt: false, shift: false } },
  ]);
});

test("refuses a key it does not know rather than sending an escape that means something else", async () => {
  const feed = routeWith();
  const response = await call(feed.route, "POST", `/api/sessions/claude/${SESSION}/composer/key`, {
    key: "f13",
  });
  expect(response!.status).toBe(400);
  expect(await response!.json()).toMatchObject({ error: { code: "key-unknown" } });
  expect(feed.pressed).toEqual([]);
});

test("a modifiers field that is not an object holds nothing, rather than throwing", async () => {
  const feed = routeWith();
  await call(feed.route, "POST", `/api/sessions/claude/${SESSION}/composer/key`, {
    key: "up",
    modifiers: "ctrl",
  });
  expect(feed.pressed).toEqual([{ key: "up", modifiers: { ctrl: false, alt: false, shift: false } }]);
});

test("every key the route accepts maps to bytes, so the two sets cannot drift apart", async () => {
  const { bytesForRailKey, NO_MODIFIERS } = await import("@agentdesk/agent-feed-wire");
  for (const key of ["escape", "tab", "up", "down", "left", "right"] as const) {
    expect(bytesForRailKey(key, NO_MODIFIERS).length).toBeGreaterThan(0);
  }
});
