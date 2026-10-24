// The proxy over real sockets, because everything it promises is about connections: what reaches
// the client when the sidecar ends a stream badly, and what reaches the sidecar when the client
// leaves. Each test stands up a throwaway upstream and a server that does nothing but proxy to it.

import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as connectHttp2, createServer as createHttp2Server } from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { proxyToSidecar } from "@/app/dev-server/sidecarProxy";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function proxyTo(upstreamPort: number): Promise<number> {
  return listen(
    createServer((incoming, outgoing) => {
      proxyToSidecar("127.0.0.1", upstreamPort, incoming.url ?? "/", incoming, outgoing);
    }),
  );
}

/** Reads a whole response through the proxy, and says whether it arrived complete. */
function read(port: number, path: string): Promise<{ status: number; body: string; complete: boolean }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, path }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      // A connection that ends mid-body is reported here as well as by `complete`; `close` below is
      // the one place both outcomes arrive.
      response.on("error", () => {});
      response.on("close", () => resolve({ status: response.statusCode ?? 0, body, complete: response.complete }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

// What a `bun --watch` reload does to every open stream. The client used to be left connected to
// nothing, and an `EventSource` only reconnects on an error or an end, so a panel tab sat silent
// until it was reloaded: measured at fifty minutes through the dev server.
test("a stream the sidecar drops mid-body is dropped for the client too", async () => {
  const upstreamPort = await listen(
    createServer((_incoming, outgoing) => {
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.write("data: one\n\n");
      setTimeout(() => outgoing.socket?.destroy(), 20);
    }),
  );
  const received = await read(await proxyTo(upstreamPort), "/api/stream");
  expect(received.status).toBe(200);
  expect(received.body).toBe("data: one\n\n");
  expect(received.complete).toBe(false);
});

test("a response the sidecar finishes arrives whole", async () => {
  const upstreamPort = await listen(
    createServer((_incoming, outgoing) => {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end('{"ok":true}');
    }),
  );
  const received = await read(await proxyTo(upstreamPort), "/api/config");
  expect(received).toEqual({ status: 200, body: '{"ok":true}', complete: true });
});

test("a client that leaves a stream takes the sidecar's end of it down", async () => {
  let upstreamClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    upstreamClosed = resolve;
  });
  const upstreamPort = await listen(
    createServer((_incoming, outgoing) => {
      outgoing.on("close", upstreamClosed);
      outgoing.writeHead(200, { "content-type": "text/event-stream" });
      outgoing.write("data: one\n\n");
    }),
  );
  const proxyPort = await proxyTo(upstreamPort);
  const outgoing = request({ host: "127.0.0.1", port: proxyPort, path: "/api/stream" }, (response) => {
    response.on("error", () => {});
    response.once("data", () => outgoing.destroy());
  });
  outgoing.on("error", () => {});
  outgoing.end();
  await closed;
});

// What a `bun --watch` reload does to a send still uploading, over HTTP/2 as the dev origin speaks
// it. The proxy answered 502 and stopped reading, the client's upload stalled on flow control, and
// a browser holds the answer until its upload is done: a phone's send button spun for good.
test("a sidecar that goes away mid-upload is answered 502, and the client's upload is let finish", async () => {
  const upstreamPort = await listen(
    createServer((incoming) => {
      let received = 0;
      incoming.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received >= 64 * 1024) incoming.socket.destroy();
      });
    }),
  );
  const front = createHttp2Server((incoming, outgoing) => {
    proxyToSidecar(
      "127.0.0.1",
      upstreamPort,
      incoming.url,
      incoming as unknown as IncomingMessage,
      outgoing as unknown as ServerResponse,
    );
  });
  await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
  const session = connectHttp2(`http://127.0.0.1:${(front.address() as AddressInfo).port}`);
  try {
    const stream = session.request({ ":method": "POST", ":path": "/api/prompt" });
    const status = new Promise<unknown>((resolve) => stream.on("response", (headers) => resolve(headers[":status"])));
    const closed = new Promise<number>((resolve) => stream.on("close", () => resolve(stream.rstCode ?? -1)));
    stream.on("error", () => {});
    stream.resume();
    // Well past one stream window, so the upload cannot finish unless the proxy keeps reading.
    stream.end(Buffer.alloc(1024 * 1024, 97));

    expect(await status).toBe(502);
    expect(await closed).toBe(0);
  } finally {
    session.destroy();
    await new Promise((resolve) => front.close(resolve));
  }
});
