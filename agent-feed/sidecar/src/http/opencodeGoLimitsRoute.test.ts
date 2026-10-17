import { expect, test } from "bun:test";
import type { VendorQuotas } from "@agentdesk/agent-feed-wire";
import { createOpencodeGoLimitsRoute } from "@/http/opencodeGoLimitsRoute";

const reading: VendorQuotas = { vendor: "opencode-go", displayName: "OpenCode Go", quotas: [] };

function serve(route: ReturnType<typeof createOpencodeGoLimitsRoute>) {
  const server = Bun.serve({
    port: 0,
    fetch: (request, bun) => route(request, new URL(request.url), bun) ?? new Response("no", { status: 404 }),
  });
  return server;
}

test("the stream carries the current reading, subscribes while open and unsubscribes on close", async () => {
  let subscribed = 0;
  let unsubscribed = 0;
  let current: VendorQuotas | null = reading;
  const server = serve(
    createOpencodeGoLimitsRoute({
      current: () => current,
      subscribe: () => {
        subscribed += 1;
        return () => {
          unsubscribed += 1;
        };
      },
    }),
  );
  try {
    expect(subscribed).toBe(0);
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.port}/api/limits/opencode-go`, { signal: controller.signal });
    const chunk = await response.body!.getReader().read();
    const text = new TextDecoder().decode(chunk.value);
    expect(JSON.parse(text.replace(/^data: /, "").trim())).toEqual({ type: "report", report: { vendors: [reading] } });
    expect(subscribed).toBe(1);
    controller.abort();
    await Bun.sleep(50);
    expect(unsubscribed).toBe(1);
    current = null;
  } finally {
    await server.stop(true);
  }
});

test("only GET on the route itself is answered", () => {
  const route = createOpencodeGoLimitsRoute({ current: () => null, subscribe: () => () => {} });
  const url = new URL("http://x/api/limits/opencode-go");
  const server = {} as never;
  expect(route(new Request(url.toString(), { method: "POST" }), url, server)).toBeUndefined();
  expect(route(new Request("http://x/api/limits"), new URL("http://x/api/limits"), server)).toBeUndefined();
});
