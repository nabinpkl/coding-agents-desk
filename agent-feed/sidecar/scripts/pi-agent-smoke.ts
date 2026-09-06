import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ActivityEvent } from "../src/transcripts/sources/transcriptTypes.ts";
import type { TimelineEnvelope } from "../src/agents/liveAgentProjection.ts";
import {
  PiAgentBackend,
  type PiSessionLocation,
} from "../src/agents/piAgentBackend.ts";

const BASH_MARKER = "AGENTDESK_PI_BASH_OK";
const FINAL_MARKER = "AGENTDESK_PI_DONE";
const TIMEOUT_MS = 180_000;

interface ViewerState {
  events: Map<number, ActivityEvent>;
  sawRunning: boolean;
  sawSettled: boolean;
  envelopes: number;
}

function requireProjectPath(): string {
  const value = process.argv[2];
  if (!value) throw new Error("usage: bun run scripts/pi-agent-smoke.ts <project-path>");
  return resolve(value);
}

function receive(viewer: ViewerState, envelope: TimelineEnvelope): void {
  viewer.envelopes += 1;
  if (envelope.kind === "snapshot") viewer.events.clear();
  for (const event of envelope.events) {
    const current = viewer.events.get(event.index);
    if (!current || current.revision <= event.revision) viewer.events.set(event.index, event);
  }
  if (envelope.runState === "running") viewer.sawRunning = true;
  if (viewer.sawRunning && envelope.runState === "idle") viewer.sawSettled = true;
}

function hasBashResult(events: Iterable<ActivityEvent>): boolean {
  for (const event of events) {
    for (const block of event.blocks) {
      if (
        block.kind === "tool_result" &&
        block.tool === "bash" &&
        block.preview?.includes(BASH_MARKER)
      ) return true;
    }
  }
  return false;
}

function hasFinalAnswer(events: Iterable<ActivityEvent>): boolean {
  for (const event of events) {
    if (event.type !== "assistant" || event.phase !== "complete") continue;
    for (const block of event.blocks) {
      if (block.kind === "text" && block.text.trim() === FINAL_MARKER) return true;
    }
  }
  return false;
}

function complete(viewer: ViewerState): boolean {
  return viewer.sawSettled &&
    hasBashResult(viewer.events.values()) &&
    hasFinalAnswer(viewer.events.values());
}

async function waitForViewers(viewers: ViewerState[]): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (viewers.every(complete)) return;
    await Bun.sleep(50);
  }
  throw new Error(`Pi smoke timed out: ${JSON.stringify(viewers.map((viewer) => ({
    envelopes: viewer.envelopes,
    sawRunning: viewer.sawRunning,
    sawSettled: viewer.sawSettled,
    events: [...viewer.events.values()],
  })))}`);
}

const projectPath = requireProjectPath();
await mkdir(projectPath, { recursive: true });
// The summarizer's model credential, which `config.ts` deletes from `process.env` before Pi
// builds tools whose child processes inherit it. This used to check the sidecar's control token;
// that token turned out to be validated by nobody and was removed, so the check moved to the
// secret that is actually still there -- a paid API key, in the environment of every tool
// subprocess an agent backend spawns if the deletion ever regresses.
if (process.env.AGENT_FEED_SUMMARY_API_KEY !== undefined) {
  throw new Error("summarizer credential remained in the Pi tool environment");
}

const locations = new Map<string, PiSessionLocation>();
const options = {
  resolveSession: (sessionId: string) => locations.get(sessionId),
  onSessionCreated: (location: PiSessionLocation) => locations.set(location.sessionId, location),
};
const backend = new PiAgentBackend(options);
let sessionId: string;
let transcriptPath: string;
try {
  const descriptor = await backend.createSession(crypto.randomUUID(), projectPath);
  sessionId = descriptor.sessionId;
  const location = locations.get(sessionId);
  if (!location) throw new Error("new Pi session was not registered");
  transcriptPath = location.transcriptPath;
  const headerLine = (await readFile(transcriptPath, "utf8")).split("\n", 1)[0];
  if (!headerLine) throw new Error("Pi session file was empty before prompt");
  const header = JSON.parse(headerLine);
  if (header.type !== "session" || header.id !== sessionId || header.cwd !== projectPath) {
    throw new Error(`Pi session header was not durable before prompt: ${JSON.stringify(header)}`);
  }

  const viewers: ViewerState[] = [
    { events: new Map(), sawRunning: false, sawSettled: false, envelopes: 0 },
    { events: new Map(), sawRunning: false, sawSettled: false, envelopes: 0 },
  ];
  const unsubscribers = await Promise.all(viewers.map((viewer) =>
    backend.subscribe(sessionId, 0, (envelope) => receive(viewer, envelope))
  ));
  try {
    await backend.send(
      sessionId,
      crypto.randomUUID(),
      `Use the built-in bash tool exactly once. Run this exact command: test -z "$AGENT_FEED_SUMMARY_API_KEY" && printf ${BASH_MARKER}\nAfter the tool completes, reply with exactly ${FINAL_MARKER} and nothing else.`,
      "next",
    );
    await waitForViewers(viewers);
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe();
  }
} finally {
  await backend.dispose();
}

const reopened = new PiAgentBackend(options);
try {
  const page = await reopened.page(sessionId!, 0, 500, "nice");
  if (!hasBashResult(page.events) || !hasFinalAnswer(page.events)) {
    throw new Error(`reopened Pi JSONL lost streamed output: ${JSON.stringify(page.events)}`);
  }
  console.log(JSON.stringify({
    event: "agent-feed-pi-smoke",
    sessionId: sessionId!,
    transcriptPath: transcriptPath!,
    events: page.total,
    viewers: 2,
    result: "PASS",
  }));
} finally {
  await reopened.dispose();
}
