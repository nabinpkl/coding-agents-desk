import { describe, expect, test } from "bun:test";
import type { ClaudeSdkClient, RunnerCommand } from "@/claude-sdk/claudeSdkClient";
import { createClaudeSdkRoutes } from "@/claude-sdk/claudeSdkRoutes";

const ID = "11111111-2222-4333-8444-555555555555";
const server = { timeout() {} } as never;

function routes() {
  const sent: RunnerCommand[] = [];
  const client = {
    command: async (_sessionId: string, command: RunnerCommand) => {
      sent.push(command);
      return { ok: true as const };
    },
  } as unknown as ClaudeSdkClient;
  const handle = createClaudeSdkRoutes(null, client);
  const post = async (action: string, body: unknown) => {
    const request = new Request(`http://127.0.0.1/api/sessions/claude/${ID}/sdk/${action}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const response = await handle(request, new URL(request.url), server);
    return { status: response!.status, body: await response!.json() as Record<string, unknown> };
  };
  return { sent, post };
}

describe("a prompt with images", () => {
  test("hands the runner the images in the API's shape, ahead of nothing else changing", async () => {
    const { sent, post } = routes();
    const answer = await post("prompt", { text: "what is this?", files: [{ data: "iVBORw0K", mime: "image/png", name: "shot.png" }] });
    expect(answer).toEqual({ status: 200, body: { ok: true } });
    expect(sent).toEqual([{ type: "prompt", text: "what is this?", images: [{ mediaType: "image/png", data: "iVBORw0K" }] }]);
  });

  test("refuses an image the API cannot take, naming it, and sends nothing", async () => {
    const { sent, post } = routes();
    const answer = await post("prompt", { text: "x", files: [{ data: "AAAA", mime: "image/heic", name: "phone.heic" }] });
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.body)).toContain("phone.heic");
    expect(sent).toEqual([]);
  });

  test("a prompt without images is the plain prompt it always was", async () => {
    const { sent, post } = routes();
    await post("prompt", { text: "hello" });
    expect(sent).toEqual([{ type: "prompt", text: "hello" }]);
  });
});

describe("a switch", () => {
  test("refuses a mode that is neither", async () => {
    const { post } = routes();
    expect(await post("switch", { mode: "headless" })).toMatchObject({ status: 400, body: { ok: false, reason: "invalid" } });
  });
});
