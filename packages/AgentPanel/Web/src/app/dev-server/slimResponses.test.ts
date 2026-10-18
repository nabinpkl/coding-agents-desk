// Over real sockets, because what this promises is about bytes on the wire: what arrives
// compressed, what arrives the moment it is written, and what a browser gets back when it follows
// the link left where a module's map used to be.

import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, test } from "vitest";
import { chooseEncoding, MAP_ROUTE, slimResponsesMiddleware } from "@/app/dev-server/slimResponses";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

/** A server whose only handler is `answer`, behind the middleware, as Vite would place it. */
async function serve(answer: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  const middleware = slimResponsesMiddleware();
  const server = createServer((incoming, outgoing) => middleware(incoming, outgoing, () => answer(incoming, outgoing)));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

interface Received {
  status: number;
  headers: IncomingMessage["headers"];
  body: string;
  /** The decompressed body exactly as sent, before any decoding. */
  bytes: Buffer;
  /** The body as it arrived, one entry per chunk. */
  chunks: string[];
}

function get(port: number, path: string, acceptEncoding = "gzip, deflate, br"): Promise<Received> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      { host: "127.0.0.1", port, path, headers: { "accept-encoding": acceptEncoding } },
      (incoming) => {
        const parts: Buffer[] = [];
        const chunks: string[] = [];
        incoming.on("data", (part: Buffer) => {
          parts.push(part);
          chunks.push(part.toString("utf8"));
        });
        incoming.on("end", () => {
          const raw = Buffer.concat(parts);
          const encoding = incoming.headers["content-encoding"];
          const body = encoding === "br" ? brotliDecompressSync(raw) : encoding === "gzip" ? gunzipSync(raw) : raw;
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: body.toString("utf8"),
            bytes: body,
            chunks,
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const MAP = JSON.stringify({
  version: 3,
  sources: ["Thing.tsx"],
  sourcesContent: ["export const thing = 1;\n".repeat(80)],
  mappings: "AAAA",
});
const MODULE = `export const thing = 1;\n${"// padding so the body is worth compressing\n".repeat(60)}`;
const inline = (code: string) =>
  `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(MAP).toString("base64")}`;

function sendModule(response: ServerResponse, code: string, type = "text/javascript") {
  response.setHeader("content-type", type);
  response.statusCode = 200;
  response.end(code);
}

describe("a module sent whole", () => {
  test("arrives compressed, with its map replaced by a link that serves the same map", async () => {
    const port = await serve((_, response) => sendModule(response, inline(MODULE)));
    const module = await get(port, "/src/Thing.tsx?t=1792268332575");
    expect(module.status).toBe(200);
    expect(module.headers["content-encoding"]).toBe("br");
    expect(module.headers.vary).toMatch(/Accept-Encoding/);
    expect(module.body).not.toContain("base64");
    const link = /\/\/# sourceMappingURL=(\S+)$/.exec(module.body)?.[1];
    expect(link).toBe(`${MAP_ROUTE}?for=${encodeURIComponent("/src/Thing.tsx")}`);
    expect(module.body.slice(0, module.body.lastIndexOf("\n"))).toBe(MODULE);

    const map = await get(port, link!);
    expect(map.status).toBe(200);
    expect(map.headers["content-type"]).toMatch(/application\/json/);
    expect(map.body).toBe(MAP);
  });

  test("goes as gzip to a client that takes no brotli, and as it is to one that takes neither", async () => {
    const port = await serve((_, response) => sendModule(response, MODULE));
    expect((await get(port, "/a.js", "gzip")).headers["content-encoding"]).toBe("gzip");
    const plain = await get(port, "/a.js", "identity");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(plain.body).toBe(MODULE);
    expect(Number(plain.headers["content-length"])).toBe(Buffer.byteLength(MODULE));
  });

  test("a text body that is not a script is compressed byte for byte, whatever its charset", async () => {
    const latin1 = Buffer.from(`café ${"résumé ".repeat(300)}`, "latin1");
    const port = await serve((_, response) => {
      response.setHeader("content-type", "text/plain; charset=iso-8859-1");
      response.statusCode = 200;
      response.end(latin1);
    });
    const answer = await get(port, "/notes.txt");
    expect(answer.headers["content-encoding"]).toBe("br");
    expect(answer.bytes.equals(latin1)).toBe(true);
  });

  test("a small body, a non-200 and a binary type are passed through untouched", async () => {
    const small = await serve((_, response) => sendModule(response, "export {};"));
    expect((await get(small, "/s.js")).headers["content-encoding"]).toBeUndefined();

    const missing = await serve((_, response) => {
      response.statusCode = 404;
      response.setHeader("content-type", "text/plain");
      response.end(MODULE);
    });
    const notFound = await get(missing, "/nope.js");
    expect(notFound.headers["content-encoding"]).toBeUndefined();
    expect(notFound.body).toBe(MODULE);

    const image = await serve((_, response) => sendModule(response, MODULE, "image/png"));
    expect((await get(image, "/a.png")).headers["content-encoding"]).toBeUndefined();
  });

  test("a later save of a module replaces its map, so the link always serves the newest", async () => {
    let version = "first";
    const port = await serve((_, response) => {
      const map = JSON.stringify({ version: 3, sources: [version], mappings: "AAAA" });
      sendModule(
        response,
        `${MODULE}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString("base64")}`,
      );
    });
    await get(port, "/src/Thing.tsx?t=1");
    version = "second";
    const module = await get(port, "/src/Thing.tsx?t=2");
    const link = /\/\/# sourceMappingURL=(\S+)$/.exec(module.body)![1]!;
    expect(JSON.parse((await get(port, link)).body).sources).toEqual(["second"]);
  });

  test("a map the server never sent is a 404 that says so", async () => {
    const port = await serve((_, response) => sendModule(response, MODULE));
    const answer = await get(port, `${MAP_ROUTE}?for=${encodeURIComponent("/src/Never.tsx")}`);
    expect(answer.status).toBe(404);
    expect(answer.body).toContain("/src/Never.tsx");
  });
});

describe("a response that streams", () => {
  test("is passed through as written, each chunk arriving before the next is sent", async () => {
    let release = () => {};
    const port = await serve((_, response) => {
      response.setHeader("content-type", "text/event-stream");
      response.statusCode = 200;
      response.write("data: one\n\n");
      release = () => response.end("data: two\n\n");
    });
    const received = get(port, "/@panel-build/stream");
    // The first chunk has to reach the client while the response is still open.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    const answer = await received;
    expect(answer.headers["content-encoding"]).toBeUndefined();
    expect(answer.chunks[0]).toBe("data: one\n\n");
    expect(answer.body).toBe("data: one\n\ndata: two\n\n");
  });

  test("an /api response is never touched, even one sent whole", async () => {
    const port = await serve((_, response) => sendModule(response, MODULE, "application/json"));
    const answer = await get(port, "/api/config");
    expect(answer.headers["content-encoding"]).toBeUndefined();
    expect(answer.headers.vary).toBeUndefined();
  });
});

describe("chooseEncoding", () => {
  test("prefers brotli, then gzip, and honours a refusal", () => {
    expect(chooseEncoding("gzip, deflate, br")).toBe("br");
    expect(chooseEncoding("gzip;q=1.0, br;q=0")).toBe("gzip");
    expect(chooseEncoding("deflate")).toBeNull();
    expect(chooseEncoding(undefined)).toBeNull();
  });
});
