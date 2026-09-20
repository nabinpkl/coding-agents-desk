// The one route that acts for the process above this one. What it has to get right is refusal: a
// panel that hears 200 for a command this machine never took would show a mode nobody is in.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSupervisorRoutes } from "@/http/supervisorRoutes";
import { readSupervisorRequest } from "@/sidecarRegistry";

/**
 * A board of this run's own, removed by the name it was handed.
 *
 * Passed in rather than pointed at by an environment variable, because the real board is shared
 * between login sessions at a fixed path and the runtime-root override does not move it: a test
 * that forgot this wrote a request onto the live machine's board, where a real supervisor reads it.
 */
const made: string[] = [];
function board(): string {
  const dir = mkdtempSync(join(tmpdir(), "supervisor-route-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

const post = (dir: string, body: unknown): Response | Promise<Response> | undefined => {
  const url = new URL("http://127.0.0.1/api/supervisor");
  const request = new Request(url.href, { method: "POST", body: JSON.stringify(body) });
  return createSupervisorRoutes(dir)(request, url, undefined as never);
};

test("records the mode the reader chose, where the supervisor will find it", async () => {
  const dir = board();
  const answer = await post(dir, { command: "manual" })!;
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ mode: "manual" });
  expect(readSupervisorRequest(dir).mode).toBe("manual");
});

test("refuses a command it does not know rather than answering as if it took it", async () => {
  const dir = board();
  const answer = await post(dir, { command: "whenever" })!;
  expect(answer.status).toBe(400);
  expect(readSupervisorRequest(dir).mode).toBe("auto");
});

test("refuses a body that is not JSON", async () => {
  const dir = board();
  const url = new URL("http://127.0.0.1/api/supervisor");
  const answer = await createSupervisorRoutes(dir)(
    new Request(url.href, { method: "POST", body: "command=manual" }),
    url,
    undefined as never,
  )!;
  expect(answer.status).toBe(400);
  expect(readSupervisorRequest(dir).apply).toBe(0);
});

test("leaves every other request to the routes after it", () => {
  const routes = createSupervisorRoutes(board());
  const other = new URL("http://127.0.0.1/api/config");
  expect(routes(new Request(other.href, { method: "POST" }), other, undefined as never)).toBeUndefined();
  const mine = new URL("http://127.0.0.1/api/supervisor");
  expect(routes(new Request(mine.href), mine, undefined as never)).toBeUndefined();
});
