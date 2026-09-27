// Over real sockets, because everything this promises is about talking to another machine: what it
// makes of an answer, what it does when there is none, and what it puts on the wire when the reader
// presses something. A stubbed transport would agree with itself about all three.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { createSupervisorClient, type Machine } from "@/app/dev-server/supervisorClient";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A stand-in sidecar: answers `/api/config` with whatever it was given, and records commands. */
async function sidecar(
  supervisor: unknown,
  sourceVersion?: string,
): Promise<{ machine: Machine; commands: string[] }> {
  const commands: string[] = [];
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        commands.push(`${request.url} ${body}`);
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ mode: "manual", apply: 0 }));
      });
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ supervisor, sourceVersion }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { machine: { label: "oracle", host: "127.0.0.1", port }, commands };
}

/** The client polls rather than awaits, so every test settles on the answer it is waiting for. */
async function settle(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("the client never answered");
}

test("reads what a machine's supervisor is doing off the answer it already asks for", async () => {
  const { machine } = await sidecar({ held: true, blocked: "sessionRoutes.ts: Syntax Error", mode: "manual" });
  const client = createSupervisorClient();
  client.refresh([machine], () => {});
  await settle(() => client.report(null).length > 0);
  expect(client.report(null)).toEqual([
    { machine: "oracle", held: true, blocked: "sessionRoutes.ts: Syntax Error", mode: "manual", behind: false },
  ]);
});

// A bundled sidecar has no supervisor at all, and a supervisor that stopped heartbeating reads the
// same way: a dead process's last words shown as live are worse than saying nothing.
test("a machine with no supervisor contributes no row", async () => {
  const { machine } = await sidecar(null);
  const client = createSupervisorClient();
  let changed = 0;
  client.refresh([machine], () => { changed += 1; });
  await settle(() => changed === 0);
  expect(client.report(null)).toEqual([]);
});

test("a field that is not the contract falls back rather than travelling", async () => {
  const { machine } = await sidecar({ held: "yes", blocked: 12, mode: "sometimes" });
  const client = createSupervisorClient();
  client.refresh([machine], () => {});
  await settle(() => client.report(null).length > 0);
  expect(client.report(null)[0]).toEqual({ machine: "oracle", held: false, blocked: null, mode: "auto", behind: false });
});

test("a machine that stops answering is forgotten rather than frozen", async () => {
  const { machine } = await sidecar({ held: true, blocked: null, mode: "auto" });
  const client = createSupervisorClient();
  client.refresh([machine], () => {});
  await settle(() => client.report(null).length > 0);

  // Off the list entirely, which is what a sidecar aging off the board looks like from here.
  let changed = 0;
  client.refresh([], () => { changed += 1; });
  expect(client.report(null)).toEqual([]);
  expect(changed).toBe(1);
});

test("an unreachable machine is a row that goes away, not an error that stops the poll", async () => {
  const client = createSupervisorClient();
  client.refresh([{ label: "gone", host: "127.0.0.1", port: 1 }], () => {});
  await settle(() => true);
  expect(client.report(null)).toEqual([]);
});

test("puts the reader's choice on the wire as the command the sidecar route takes", async () => {
  const { machine, commands } = await sidecar({ held: false, blocked: null, mode: "auto" });
  const client = createSupervisorClient();
  client.tell([machine], "manual");
  await settle(() => commands.length > 0);
  expect(commands[0]).toBe('/api/supervisor {"command":"manual"}');
});

test("tells every machine, since one switch covers all of them", async () => {
  const first = await sidecar({ held: false, blocked: null, mode: "auto" });
  const second = await sidecar({ held: false, blocked: null, mode: "auto" });
  const client = createSupervisorClient();
  client.tell([first.machine, second.machine], "apply");
  await settle(() => first.commands.length > 0 && second.commands.length > 0);
  expect(second.commands[0]).toContain('"apply"');
});

// Behind means running different code from the tree the panel is served from. A sidecar too old to
// say which code it runs is not called behind, because that would be a guess.
test("calls a machine behind only when the code it reports differs from the tree's", async () => {
  const idle = { held: false, blocked: null, mode: "manual" };
  const { machine: current } = await sidecar(idle, "aaaaaaaaaaaa");
  const { machine: silent } = await sidecar(idle);
  const client = createSupervisorClient();
  client.refresh([{ ...current, label: "mac" }, { ...silent, label: "old" }], () => {});
  await settle(() => client.report(null).length === 2);

  const behind = (tree: string | null) =>
    Object.fromEntries(client.report(tree).map((entry) => [entry.machine, entry.behind]));
  expect(behind("aaaaaaaaaaaa")).toEqual({ mac: false, old: false });
  expect(behind("bbbbbbbbbbbb")).toEqual({ mac: true, old: false });
  expect(behind(null)).toEqual({ mac: false, old: false });
});
