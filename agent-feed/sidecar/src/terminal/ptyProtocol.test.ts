import { expect, test } from "bun:test";
import {
  PTY_PROTOCOL_VERSION,
  decodePtyEnvelope,
  encodePtyEnvelope,
  framePtyEnvelope,
  takePtyFrames,
} from "@/terminal/ptyProtocol";

test("PTY protobuf codec preserves terminal output bytes and 64-bit revisions", () => {
  const encoded = encodePtyEnvelope({
    protocolVersion: PTY_PROTOCOL_VERSION,
    requestId: "42",
    sessionName: "agent-resume-claude-session",
    output: { data: "AGhlbGxv/w==", revision: "9007199254740993" },
  });

  expect(decodePtyEnvelope(encoded)).toMatchObject({
    protocolVersion: PTY_PROTOCOL_VERSION,
    requestId: "42",
    sessionName: "agent-resume-claude-session",
    output: { data: "AGhlbGxv/w==", revision: "9007199254740993" },
  });
});

test("PTY framing returns complete envelopes and retains a partial tail", () => {
  const first = framePtyEnvelope({
    protocolVersion: PTY_PROTOCOL_VERSION,
    requestId: "1",
    listSessions: {},
  });
  const second = framePtyEnvelope({
    protocolVersion: PTY_PROTOCOL_VERSION,
    requestId: "2",
    sessionName: "session",
    input: { data: "aGk=" },
  });
  const joined = new Uint8Array(first.byteLength + second.byteLength - 2);
  joined.set(first);
  joined.set(second.subarray(0, second.byteLength - 2), first.byteLength);

  const decoded = takePtyFrames(joined);

  expect(decoded.frames).toHaveLength(1);
  expect(decoded.frames[0]?.listSessions).toEqual({});
  expect(decoded.remainder.byteLength).toBe(second.byteLength - 2);
});
