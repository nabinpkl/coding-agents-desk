import { describe, expect, test } from "bun:test";
import { LineReader, LineWriter, type LineSink } from "@/claude-sdk/claudeSdkProtocol";

/** A socket that takes at most `take` bytes per write, as a Bun socket does when the kernel is full. */
function narrowSocket(take: number) {
  const received: number[] = [];
  const socket: LineSink = {
    write(data) {
      const taken = data.subarray(0, take);
      received.push(...taken);
      return taken.length;
    },
  };
  return { socket, text: () => Buffer.from(received).toString() };
}

describe("writing lines to a socket that takes part of each write", () => {
  test("keeps the rest and writes it on each drain, in order, cutting by bytes", () => {
    // Two bytes a write, so the first cut falls inside "é".
    const { socket, text } = narrowSocket(2);
    const writer = new LineWriter(1024);
    expect(writer.write(socket, "héllo wörld\n")).toBe(true);
    expect(text()).toBe("h�");
    expect(writer.write(socket, "second\n")).toBe(true);
    expect(text()).toBe("hél");
    for (let drains = 0; drains < 20; drains += 1) writer.flush(socket);
    expect(text()).toBe("héllo wörld\nsecond\n");
  });

  test("says so once what it keeps passes its limit", () => {
    const { socket } = narrowSocket(0);
    const writer = new LineWriter(8);
    expect(writer.write(socket, "1234567\n")).toBe(true);
    expect(writer.write(socket, "x\n")).toBe(false);
  });
});

describe("reading lines from a stream", () => {
  test("joins a line that arrives in pieces, a multi-byte character split among them", () => {
    const bytes = new TextEncoder().encode('{"a":"ü"}\n{"b":2}\n{"c"');
    const reader = new LineReader();
    const lines: string[] = [];
    for (let at = 0; at < bytes.length; at += 3) lines.push(...reader.push(bytes.subarray(at, at + 3)));
    expect(lines).toEqual(['{"a":"ü"}', '{"b":2}']);
    expect(reader.push(new TextEncoder().encode(":3}\n"))).toEqual(['{"c":3}']);
  });

  test("reads a line of many megabytes in small chunks", () => {
    const line = "x".repeat(16 * 1024 * 1024);
    const bytes = new TextEncoder().encode(`${line}\n`);
    const reader = new LineReader();
    const lines: string[] = [];
    for (let at = 0; at < bytes.length; at += 8192) lines.push(...reader.push(bytes.subarray(at, at + 8192)));
    expect(lines.length).toBe(1);
    expect(lines[0]!.length).toBe(line.length);
  });
});
