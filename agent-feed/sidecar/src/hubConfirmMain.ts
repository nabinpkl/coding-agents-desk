// Tells the hub one message reached its session, for a mod that cannot hold the machine token:
//
//   bun src/hubConfirmMain.ts <message id> <stream id>
//
// The mod runs this once the message's prompt has entered the session, with the stream id the hub
// reader printed beside the message. The token stays in this process and the reader; a mod's own
// `$.fs.read` and `$.http.fetch` calls can be seen by every other mod in the session.
//
// Prints the message's id and new state as one JSON line and exits 0, or says why on stderr and
// exits 1. A refusal means the message was no longer waiting on that stream (the stream dropped and
// the hub requeued it), which is the mod's cue to expect it again.
import { HubClient, loadHubSettings } from "@/messaging/hubClient";
import { confirmDelivery } from "@/messaging/relayChannel";

const [messageId, streamId] = process.argv.slice(2);
if (!messageId || !streamId) {
  console.error("hub confirm: usage: hubConfirmMain.ts <message id> <stream id>");
  process.exit(64);
}
const settings = loadHubSettings();
if (typeof settings === "string") {
  console.error(`hub confirm: ${settings}`);
  process.exit(78);
}
try {
  const message = await confirmDelivery(new HubClient(settings), messageId, streamId);
  console.log(JSON.stringify({ id: message.id, state: message.state }));
} catch (error) {
  console.error(`hub confirm: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
