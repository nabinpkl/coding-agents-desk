import { expect, test } from "bun:test";
import type { TmuxQuestionAnswer, TmuxQuestionPoint } from "@agentdesk/agent-feed-wire";
import {
  createTmuxQuestionRoutes,
  type TmuxQuestionDependencies,
} from "@/http/session-routes/tmuxQuestionRoutes";

const SESSION = "2adc3708-fadb-4e2f-a744-322df224faf4";
const server = { timeout() {} } as never;

function routeWith(overrides: Partial<TmuxQuestionDependencies> = {}) {
  const answered: { sessionId: string; answers: readonly TmuxQuestionAnswer[] }[] = [];
  const pointed: { sessionId: string; point: TmuxQuestionPoint }[] = [];
  const question: TmuxQuestionDependencies = {
    answer: async (sessionId, answers) => {
      answered.push({ sessionId, answers });
      return { answered: true };
    },
    point: async (sessionId, point) => {
      pointed.push({ sessionId, point });
      return { pointed: true };
    },
    ...overrides,
  };
  return { route: createTmuxQuestionRoutes(question), answered, pointed };
}

function call(
  route: ReturnType<typeof createTmuxQuestionRoutes>,
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

const ONE: TmuxQuestionAnswer = {
  question: "Which colour?",
  chosen: [{ index: 1, label: "BRAVO" }],
  other: "",
};

test("the route is Claude's, and only a POST", async () => {
  const { route } = routeWith();
  expect(await call(route, "POST", `/api/sessions/codex/${SESSION}/question`, { answers: [ONE] }))
    .toBeUndefined();
  expect(await call(route, "GET", `/api/sessions/claude/${SESSION}/question`)).toBeUndefined();
  // No read side by construction: whether a question is open comes from the transcript, and a
  // second answer polled off a pane would drift from it exactly when the two disagreed.
  expect(await call(route, "GET", `/api/sessions/claude/${SESSION}/question/stream`)).toBeUndefined();
});

test("answers reach the driver with their labels intact", async () => {
  const { route, answered } = routeWith();
  const response = await call(route, "POST", `/api/sessions/claude/${SESSION}/question`, {
    answers: [ONE, { question: "Which toppings?", chosen: [], other: "  something else  " }],
  });

  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({ answered: true });
  expect(answered).toHaveLength(1);
  expect(answered[0]!.sessionId).toBe(SESSION);
  expect(answered[0]!.answers).toEqual([
    ONE,
    // The free text is passed through untouched, spaces included: it is what a person wrote.
    { question: "Which toppings?", chosen: [], other: "  something else  " },
  ]);
});

test("a refusal answers 200 so its kept text is not thrown away as a failed request", async () => {
  const { route } = routeWith({
    answer: async () => ({
      answered: false,
      reason: "no-dialog",
      sent: false,
      keptText: [{ question: "Which colour?", text: "what I wrote" }],
    }),
  });
  const response = await call(route, "POST", `/api/sessions/claude/${SESSION}/question`, {
    answers: [{ question: "Which colour?", chosen: [], other: "what I wrote" }],
  });

  expect(response?.status).toBe(200);
  expect(await response!.json()).toEqual({
    answered: false,
    reason: "no-dialog",
    // Passed through as the driver reported it: whether any key reached the pane is the caller's
    // to say, and the route is not the place to decide it.
    sent: false,
    keptText: [{ question: "Which colour?", text: "what I wrote" }],
  });
});

test("a request that names no question is refused before it reaches a pane", async () => {
  const { route, answered } = routeWith();
  for (
    const body of [
      {},
      { answers: [] },
      { answers: [{ chosen: [{ index: 0, label: "A" }] }] },
      { answers: [{ question: "  ", chosen: [{ index: 0, label: "A" }] }] },
    ]
  ) {
    expect((await call(route, "POST", `/api/sessions/claude/${SESSION}/question`, body))?.status)
      .toBe(400);
  }
  expect(answered).toEqual([]);
});

test("a choice without the label its index should name is refused", async () => {
  const { route, answered } = routeWith();
  // The label is the whole of the safety check the driver makes before pressing a row. A caller
  // that sends only an index is asking to have an answer counted onto whatever is there.
  const body = { answers: [{ question: "Which colour?", chosen: [{ index: 1 }], other: "" }] };
  expect((await call(route, "POST", `/api/sessions/claude/${SESSION}/question`, body))?.status)
    .toBe(400);
  expect(answered).toEqual([]);
});

test("a question with neither a choice nor text is refused", async () => {
  const { route, answered } = routeWith();
  const body = { answers: [{ question: "Which colour?", chosen: [], other: "" }] };
  // Walking past it would leave the dialog unfinished and the review screen refusing, with no
  // surface anywhere saying which question was skipped.
  expect((await call(route, "POST", `/api/sessions/claude/${SESSION}/question`, body))?.status)
    .toBe(400);
  expect(answered).toEqual([]);
});

test("free text carrying a line break is refused rather than quietly straightened", async () => {
  const { route, answered } = routeWith();
  const body = { answers: [{ question: "Q?", chosen: [], other: "first line\nsecond line" }] };
  // A newline presses Return partway through typing, committing half an answer and moving the
  // dialog on. Stripping it would send words the reader did not write.
  expect((await call(route, "POST", `/api/sessions/claude/${SESSION}/question`, body))?.status)
    .toBe(400);
  expect(answered).toEqual([]);
});

test("free text longer than a row will take is refused", async () => {
  const { route } = routeWith();
  const body = { answers: [{ question: "Q?", chosen: [], other: "x".repeat(4_001) }] };
  expect((await call(route, "POST", `/api/sessions/claude/${SESSION}/question`, body))?.status)
    .toBe(400);
});

test("a body that is not JSON is refused", async () => {
  const { route } = routeWith();
  const url = new URL(`http://127.0.0.1/api/sessions/claude/${SESSION}/question`);
  const response = await route(new Request(url.toString(), { method: "POST", body: "{" }), url, server);
  expect(response?.status).toBe(400);
});

const POINT: TmuxQuestionPoint = {
  questions: ["Which colour?"],
  at: 0,
  option: 1,
  label: "BRAVO",
};

test("a point reaches the driver with the question it names", async () => {
  const { route, pointed, answered } = routeWith();
  const response = await call(route, "POST", `/api/sessions/claude/${SESSION}/question/point`, POINT);

  expect(await response!.json()).toEqual({ pointed: true });
  expect(pointed).toEqual([{ sessionId: SESSION, point: POINT }]);
  // The two drivers are separate because they may press different keys. Pointing must never reach
  // the one that can finish the dialog.
  expect(answered).toEqual([]);
});

test("a point is refused when it names no question text to find the dialog by", async () => {
  const { route, pointed } = routeWith();
  const response = await call(route, "POST", `/api/sessions/claude/${SESSION}/question/point`, {
    ...POINT,
    questions: ["Which colour?", "  "],
  });

  // The dialog is located by matching question text, so a blank entry leaves one tab
  // unrecognisable and the walk with nothing to stop at.
  expect(response!.status).toBe(400);
  expect(pointed).toEqual([]);
});

test("a point is refused when it is about a question the call does not have", async () => {
  const { route, pointed } = routeWith();
  const response = await call(route, "POST", `/api/sessions/claude/${SESSION}/question/point`, {
    ...POINT,
    at: 3,
  });

  expect(response!.status).toBe(400);
  expect(pointed).toEqual([]);
});

test("the answer path is not reachable through the point path", async () => {
  const { route } = routeWith();
  // `/question` is anchored, so this is a check that it stays that way: a body shaped like an
  // answer posted at the point path must not be run as one.
  const response = await call(route, "GET", `/api/sessions/claude/${SESSION}/question/point`, POINT);
  expect(response).toBeUndefined();
});
