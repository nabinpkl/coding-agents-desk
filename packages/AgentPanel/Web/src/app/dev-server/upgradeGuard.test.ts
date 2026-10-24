// Who may open the dev server's own WebSockets. Over a real socket as well as by the rule, because
// what matters is what a browser on the other end sees: an open socket for this origin's page, and a
// 403 for any other page's.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { refuseUpgrade, upgradeRefusal } from "@/app/dev-server/upgradeGuard";

const PANEL = "mac.example.ts.net";

test("this origin's page may open one, under any of the names this server answers to", () => {
  expect(upgradeRefusal({ host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" }, PANEL)).toBeNull();
  expect(upgradeRefusal({ host: "localhost:5173", origin: "http://localhost:5173" }, PANEL)).toBeNull();
  expect(upgradeRefusal({ host: "[::1]:5173", origin: "http://[::1]:5173" }, PANEL)).toBeNull();
  expect(upgradeRefusal({ host: `${PANEL}:5173`, origin: `https://${PANEL}:5173` }, PANEL)).toBeNull();
  // A phone on the local network loads the panel by this Mac's address in network mode.
  expect(upgradeRefusal({ host: "10.0.0.13:5173", origin: "http://10.0.0.13:5173" }, PANEL)).toBeNull();
});

test("another page may not, whatever it claims", () => {
  expect(upgradeRefusal({ host: "127.0.0.1:5173", origin: "https://example.com" }, PANEL)).toMatch(
    /origin not allowed/,
  );
  expect(upgradeRefusal({ host: "127.0.0.1:5173", origin: "http://127.0.0.1:3000" }, PANEL)).toMatch(
    /origin not allowed/,
  );
  expect(upgradeRefusal({ host: `${PANEL}:5173`, origin: "http://127.0.0.1:5173" }, PANEL)).toMatch(
    /origin not allowed/,
  );
  expect(upgradeRefusal({ host: "127.0.0.1:5173", origin: "null" }, PANEL)).toMatch(/origin not allowed/);
});

test("a name pointed at this Mac by someone else is refused, even with a matching origin", () => {
  // DNS rebinding: the attacker's page is same-origin with itself, so only the Host gives it away.
  expect(upgradeRefusal({ host: "attacker.example:5173", origin: "http://attacker.example:5173" }, PANEL)).toMatch(
    /host not allowed: attacker\.example/,
  );
  expect(upgradeRefusal({ origin: "http://127.0.0.1:5173" }, PANEL)).toBe("no Host");
});

test("a client that is not a browser sends no Origin and is let through on this server's names", () => {
  expect(upgradeRefusal({ host: "127.0.0.1:5173" }, PANEL)).toBeNull();
  expect(upgradeRefusal({ host: "attacker.example:5173" }, PANEL)).toMatch(/host not allowed/);
});

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function guardedServer(): Promise<number> {
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    const refusal = upgradeRefusal(request.headers, PANEL);
    if (refusal) {
      refuseUpgrade(socket, refusal);
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => ws.send("opened"));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function attempt(url: string, options: { origin?: string; headers?: Record<string, string> }): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options);
    ws.once("message", (data) => {
      resolve(`open: ${String(data)}`);
      ws.close();
    });
    ws.once("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", (chunk) => (body += String(chunk)));
      response.on("end", () => resolve(`${response.statusCode}: ${body.trim()}`));
    });
    ws.once("error", (error) => resolve(`error: ${error.message}`));
  });
}

test("over a real socket, this origin opens and another page is answered with a 403", async () => {
  const port = await guardedServer();
  const url = `ws://127.0.0.1:${port}/vnc`;
  expect(await attempt(url, { origin: `http://127.0.0.1:${port}` })).toBe("open: opened");
  expect(await attempt(url, { origin: "https://example.com" })).toBe("403: origin not allowed: https://example.com");
  expect(
    await attempt(url, { origin: `http://attacker.example:${port}`, headers: { host: `attacker.example:${port}` } }),
  ).toBe("403: host not allowed: attacker.example");
});
