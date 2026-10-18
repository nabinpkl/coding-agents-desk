// Entrypoint for the hub reader (`messaging/hubReader.ts`), started by a mod with
// `$.process.spawn`:
//
//   bun src/hubReaderMain.ts <session id> [cwd] [title]
//
// stdout carries reader lines only; every log goes to stderr. Exits when its parent goes, when a
// write to stdout fails, or on SIGTERM, which is how Claude Code ends a spawned child with its
// session.
import { HubClient, loadHubSettings } from "@/messaging/hubClient";
import { readerLine, runHubReader, watchParent } from "@/messaging/hubReader";

const BEAT_MS = 5_000;
const SESSION_ID = /^[0-9a-zA-Z_-]{1,128}$/;

const [sessionId, cwd = process.cwd(), title = ""] = process.argv.slice(2);
if (!sessionId || !SESSION_ID.test(sessionId)) {
  console.error("hub reader: usage: hubReaderMain.ts <session id> [cwd] [title]");
  process.exit(64);
}
const settings = loadHubSettings();
if (typeof settings === "string") {
  console.error(`hub reader: ${settings}`);
  process.exit(78);
}

const log = (text: string) => console.error(`[hub reader ${sessionId}] ${text}`);
const stop = new AbortController();
const leave = (why: string) => {
  log(`exiting: ${why}`);
  stop.abort();
  process.exit(0);
};

// A write to a pipe whose reader has gone is the reader's surest sign the session is over.
process.stdout.on("error", () => leave("stdout closed"));
const write = (line: string) => {
  try {
    process.stdout.write(line);
  } catch {
    leave("stdout closed");
  }
};

process.on("SIGTERM", () => leave("SIGTERM"));
watchParent({ parentPid: () => process.ppid, intervalMs: BEAT_MS, gone: () => leave("parent gone") });
setInterval(() => write(readerLine({ type: "beat" })), BEAT_MS);

await runHubReader({ hub: new HubClient(settings), sessionId, cwd, title, write, log }, stop.signal);
