import { expect, test } from "bun:test";
import { createAskOwnerRoutes } from "@/asks/askOwnerRoutes";
import { AskOwnerWaits } from "@/asks/askOwnerWaits";
import { until } from "@/testing/until";

const SESSION = "2adc3708-fadb-4e2f-a744-322df224faf4";
const server = { timeout() {} } as never;

const CALL = {
  toolUseId: "toolu_01",
  source: "claude",
  sessionId: SESSION,
  questions: [{ id: "name", question: "What should it be called?", kind: "text", options: [] }],
};

function routes() {
  const waits = new AskOwnerWaits();
  const route = createAskOwnerRoutes(waits);
  const call = (method: string, path: string, body?: unknown, signal?: AbortSignal) => {
    const url = new URL(`http://127.0.0.1${path}`);
    const request = new Request(url.toString(), {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    return route(request, url, server);
  };
  return { waits, call };
}

/** Every `data:` payload a stream sends, read until it ends or `enough` of them have come. */
async function events(response: Response, enough = Number.POSITIVE_INFINITY): Promise<unknown[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const seen: unknown[] = [];
  let buffered = "";
  while (seen.length < enough) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const frames = buffered.split("\n\n");
    buffered = frames.pop()!;
    for (const frame of frames) if (frame.startsWith("data: ")) seen.push(JSON.parse(frame.slice(6)));
  }
  reader.releaseLock();
  return seen;
}

test("a waiting call reaches its session's stream, and the answer ends the wait with the verdict", async () => {
  const { call } = routes();
  const waiting = (await call("POST", "/api/asks", CALL))!;
  expect(waiting.headers.get("content-type")).toBe("text/event-stream");

  const watching = (await call("GET", `/api/sessions/claude/${SESSION}/asks/stream`))!;
  const [first] = (await events(watching, 1)) as [{ asks: { toolUseId: string; askedAt: number }[] }];
  expect(first.asks.map((ask) => ask.toolUseId)).toEqual(["toolu_01"]);

  const answers = [{ id: "name", chosen: [], text: "Ledger" }];
  const answered = (await call("POST", `/api/sessions/claude/${SESSION}/asks/toolu_01/answer`, { answers }))!;
  expect(await answered.json()).toEqual({ delivered: true });
  expect(await events(waiting)).toEqual([{ answered: answers }]);
  expect(await events(watching, 1)).toEqual([{ asks: [] }]);
});

test("a dismissal ends the wait too, and a second answer finds nothing waiting", async () => {
  const { call } = routes();
  const waiting = (await call("POST", "/api/asks", CALL))!;
  const dismissed = (await call("POST", `/api/sessions/claude/${SESSION}/asks/toolu_01/dismiss`))!;
  expect(await dismissed.json()).toEqual({ delivered: true });
  expect(await events(waiting)).toEqual([{ dismissed: true }]);
  const late = (await call("POST", `/api/sessions/claude/${SESSION}/asks/toolu_01/answer`, { answers: [] }))!;
  expect(await late.json()).toMatchObject({ delivered: false, reason: "not-waiting" });
});

test("a call stops waiting when the request holding it goes away", async () => {
  const { waits, call } = routes();
  const holder = new AbortController();
  await call("POST", "/api/asks", CALL, holder.signal);
  const shown: string[][] = [];
  waits.observe("claude", SESSION, (asks) => shown.push(asks.map((ask) => ask.toolUseId)));
  expect(shown.at(-1)).toEqual(["toolu_01"]);
  holder.abort();
  await until(() => shown.at(-1)?.length === 0, "the call to stop waiting");
});

test("refuses a call it could not show, and paths that are not its own", async () => {
  const { call } = routes();
  const refused = (await call("POST", "/api/asks", { ...CALL, questions: [] }))!;
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: { code: "ask-invalid" } });
  expect(await call("GET", "/api/asks")).toBeUndefined();
  expect(await call("POST", `/api/sessions/claude/${SESSION}/asks/stream`)).toBeUndefined();
  expect(await call("GET", `/api/sessions/codex/${SESSION}/asks/stream`)).toBeUndefined();
});
