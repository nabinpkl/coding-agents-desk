import { afterEach, describe, expect, test } from "bun:test";
import { AUDIO_LISTENERS_ROUTE } from "@agentdesk/agent-feed-wire";
import { speechPort } from "@/audio/audioConfig";
import { createSpeechPushExperimentRoutes } from "@/audio/speechPushExperiment";

const server = {} as never;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function listeners() {
  const request = new Request(`http://localhost${AUDIO_LISTENERS_ROUTE}`);
  const response = await createSpeechPushExperimentRoutes()(request, new URL(request.url), server);
  return { status: response?.status, body: await response?.json() };
}

describe("who is listening, while the experiment speaks", () => {
  test("counts the pages listening to the speech process, where a spoken message goes", async () => {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(url);
      return Response.json({ listeners: 2 });
    }) as typeof fetch;
    expect(await listeners()).toEqual({ status: 200, body: { listeners: 2 } });
    expect(asked).toEqual([`http://127.0.0.1:${speechPort()}/listeners`]);
  });

  test("says so when the speech process does not answer with a count", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("connection refused"))) as unknown as typeof fetch;
    expect(await listeners()).toMatchObject({ status: 502, body: { error: { code: "speech_unreachable" } } });
    globalThis.fetch = (async () => Response.json({ error: "no route" }, { status: 404 })) as unknown as typeof fetch;
    expect(await listeners()).toMatchObject({ status: 502, body: { error: { code: "speech_failed" } } });
  });
});
