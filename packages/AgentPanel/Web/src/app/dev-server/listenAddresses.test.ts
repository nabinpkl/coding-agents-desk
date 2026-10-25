// Where the dev server listens, over real sockets where it matters: a listener on a second address
// has to hand its connections to the one server and go away with it, or the dev server is reachable
// somewhere it was not asked to be.

import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import {
  isTailnetAddress,
  listenAddresses,
  listenAlso,
  LISTEN_MODE_ROUTE,
  panelListen,
  parseListenMode,
} from "@/app/dev-server/listenAddresses";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function serving(body: string): Promise<{ server: Server; port: number }> {
  const server = createServer((_request, response) => response.end(body));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

function get(host: string, port: number, path = "/"): Promise<string> {
  return new Promise((resolve, reject) => {
    request({ host, port, path }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += String(chunk)));
      response.on("end", () => resolve(body));
    })
      .on("error", reject)
      .end();
  });
}

function refused(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

test("the default is loopback, and anything but the three modes is refused", () => {
  expect(parseListenMode(undefined)).toBe("loopback");
  expect(parseListenMode("")).toBe("loopback");
  expect(parseListenMode("tailnet")).toBe("tailnet");
  expect(parseListenMode("network")).toBe("network");
  expect(() => parseListenMode("all")).toThrow(/must be one of loopback, tailnet, network/);
});

test("tailnet addresses are 100.64.0.0/10 and nothing else", () => {
  for (const address of ["100.64.0.1", "100.100.42.7", "100.127.255.255"]) {
    expect(isTailnetAddress(address)).toBe(true);
  }
  for (const address of [
    "100.63.255.255",
    "100.128.0.1",
    "10.0.0.13",
    "192.168.1.2",
    "1.2.3",
    "100.64.0.256",
    "fd7a::1",
  ]) {
    expect(isTailnetAddress(address)).toBe(false);
  }
});

test("each mode listens where it says", async () => {
  expect(await listenAddresses("loopback", "mac.example.ts.net")).toEqual({
    mode: "loopback",
    host: "127.0.0.1",
    also: [],
  });
  expect(await listenAddresses("network", undefined)).toEqual({ mode: "network", host: true, also: [] });
  const resolved: string[] = [];
  const tailnet = await listenAddresses("tailnet", "mac.example.ts.net", async (name) => {
    resolved.push(name);
    return "100.100.1.1";
  });
  expect(resolved).toEqual(["mac.example.ts.net"]);
  expect(tailnet).toEqual({ mode: "tailnet", host: "100.100.1.1", also: ["127.0.0.1"] });
});

test("tailnet mode will not start without a name, an answer, or a tailnet address", async () => {
  await expect(listenAddresses("tailnet", undefined)).rejects.toThrow(/needs the panel's tailnet name/);
  await expect(
    listenAddresses("tailnet", "mac.example.ts.net", async () => {
      throw new Error("ENOTFOUND");
    }),
  ).rejects.toThrow(/does not resolve/);
  await expect(listenAddresses("tailnet", "mac.example.ts.net", async () => "10.0.0.13")).rejects.toThrow(
    /10\.0\.0\.13, which is not a tailnet address/,
  );
});

test("a further address is answered by the same server, and closes with it", async () => {
  const { server, port } = await serving("from the one server");
  await listenAlso(server, ["::1"]);
  expect(await get("::1", port)).toBe("from the one server");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  servers.splice(servers.indexOf(server), 1);
  expect(await refused("::1", port)).toBe(true);
});

test("an address that cannot be listened on rejects and leaves nothing listening", async () => {
  const { server, port } = await serving("unused");
  // 192.0.2.0/24 is reserved for documentation, so no machine running this has it.
  await expect(listenAlso(server, ["::1", "192.0.2.1"])).rejects.toThrow(/EADDRNOTAVAIL/);
  expect(await refused("::1", port)).toBe(true);
});

test("the server says which mode it is in", async () => {
  const handlers = new Map<
    string,
    (request: unknown, response: { setHeader: () => void; end: (body: string) => void }) => void
  >();
  const fakeServer = {
    middlewares: { use: (path: string, handler: never) => handlers.set(path, handler) },
    httpServer: null,
  };
  const plugin = panelListen({ mode: "tailnet", host: "100.100.1.1", also: [] });
  (plugin.configureServer as (server: unknown) => void)(fakeServer);
  let body = "";
  handlers.get(LISTEN_MODE_ROUTE)?.({}, { setHeader: () => {}, end: (text) => (body = text) });
  expect(body).toBe("tailnet");
});
