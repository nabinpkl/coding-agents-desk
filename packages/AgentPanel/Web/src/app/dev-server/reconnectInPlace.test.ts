/**
 * @vitest-environment node
 *
 * Whether Vite's client, rewritten, still parses and reconnects in place rather than reloading.
 * Run on the real file, so a Vite that moves the lines this changes fails here rather than bringing
 * the reload on every return to the panel back without a word.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changesPage,
  patchViteClient,
  reconnectInPlace,
  RECONNECT_ROUTE,
  RELOAD_WAITING_EVENT,
  SENT_EVENT,
} from "@/app/dev-server/reconnectInPlace";
import * as radio from "@/features/audio-channel/radioListener";

const require = createRequire(import.meta.url);
const CLIENT = join(require.resolve("vite/package.json"), "..", "dist", "client", "client.mjs");

describe("Vite's client, rewritten", () => {
  const patched = patchViteClient(readFileSync(CLIENT, "utf8"));

  it("asks before reloading, and connects again where it is when nothing was missed", () => {
    expect(patched).toContain("if (await __panelKeepPage()) transport.connect(createHMRHandler(handleMessage));");
    expect(patched).toContain("else location.reload();");
    expect(patched).toContain(`if (payload.event === "${SENT_EVENT}") __panelSeen = payload.data;`);
    expect(patched).toContain(`fetch("${RECONNECT_ROUTE}"`);
  });

  it("still parses", () => {
    const directory = mkdtempSync(join(tmpdir(), "reconnect-in-place-"));
    try {
      const file = join(directory, "client.mjs");
      writeFileSync(file, patched);
      execFileSync(process.execPath, ["--check", file]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("asks the panel by the names the panel answers to", () => {
    expect(patched).toContain(`window.${radio.HOLD_RELOAD_GLOBAL}()`);
    expect(patched).toContain(`window.${radio.RELOAD_WAITING_GLOBAL} = true`);
    expect(RELOAD_WAITING_EVENT).toBe(radio.RELOAD_WAITING_EVENT);
  });

  it("refuses a client whose lines have moved, rather than serving one that reloads", () => {
    expect(() => patchViteClient("location.reload();")).toThrow(/no longer has/);
  });
});

/** A stand-in for the dev server: its client channel and its middleware. */
function fakeServer() {
  const broadcast: unknown[][] = [];
  const connects: ((data: unknown, client: { send(event: string, data: unknown): void }) => void)[] = [];
  let route:
    | ((request: { url: string }, response: { setHeader(): void; end(body: string): void }, next: () => void) => void)
    | null = null;
  const hot = {
    send: (...args: unknown[]) => void broadcast.push(args),
    on: (event: string, listener: (typeof connects)[number]) => {
      if (event === "vite:client:connect") connects.push(listener);
    },
  };
  const dev = {
    environments: { client: { hot } },
    middlewares: { use: (handler: NonNullable<typeof route>) => (route = handler) },
  };
  const ask = () => {
    let body = "";
    route?.({ url: RECONNECT_ROUTE }, { setHeader: () => undefined, end: (text) => (body = text) }, () => undefined);
    return JSON.parse(body) as { server: string; sent: number };
  };
  return { dev, hot, broadcast, connects, ask };
}

describe("counting what the server sends", () => {
  it("counts each update and reload, tells the pages, and answers the same number when asked", () => {
    const server = fakeServer();
    const plugin = reconnectInPlace();
    (plugin.configureServer as (dev: unknown) => void)(server.dev);
    expect(server.ask().sent).toBe(0);
    server.hot.send({ type: "update", updates: [] });
    server.hot.send("panel:publish", {});
    server.hot.send({ type: "full-reload" });
    expect(server.ask().sent).toBe(2);
    // Each counted payload is followed by the count, so a page always holds the number it last saw.
    expect(server.broadcast.filter(([event]) => event === SENT_EVENT).map(([, data]) => data)).toEqual([
      { server: server.ask().server, sent: 1 },
      { server: server.ask().server, sent: 2 },
    ]);
    const told: unknown[] = [];
    server.connects[0]?.(undefined, { send: (_event, data) => told.push(data) });
    expect(told).toEqual([{ server: server.ask().server, sent: 2 }]);
  });

  it("names a different server after a restart, so a page from before reloads", () => {
    const first = fakeServer();
    const second = fakeServer();
    (reconnectInPlace().configureServer as (dev: unknown) => void)(first.dev);
    (reconnectInPlace().configureServer as (dev: unknown) => void)(second.dev);
    expect(first.ask().server).not.toBe(second.ask().server);
  });

  it("leaves custom events and pings out of the count", () => {
    expect(changesPage({ type: "custom", event: "x" })).toBe(false);
    expect(changesPage({ type: "connected" })).toBe(false);
    expect(changesPage("panel:publish")).toBe(false);
  });
});
