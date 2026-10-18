/**
 * A fake sidecar behind the real relay, so the panel can run with no host and no agents.
 *
 * It answers `agent-http-req` frames rather than standing in for the data source, which means
 * fixture mode exercises the whole path the product uses: request correlation, chunk reassembly,
 * subscription framing, and the wire shapes themselves. The previous fixture faked thirteen typed
 * message pairs, so it could and did drift from the host it imitated; there is one envelope to
 * imitate now, and it carries no field of anything the sidecar says.
 */
import { route } from "@/app/fake-sidecar/fixtureRoutes";

// Re-exported: `main.tsx` installs the fixture, and the panel's own tests read the
// canned data. The declarations live in `fixtureData.ts`.
export { FIXTURE_PROJECTS, FIXTURE_SESSIONS } from "@/app/fake-sidecar/fixtureData";

/**
 * Installs the fake sidecar as the page's message handler.
 *
 * Must run before the transport is constructed: the transport picks its backend by whether this
 * handler exists.
 */
export function installFixture(): void {
  const open = new Set<string>();

  const deliver = (frame: unknown) => window.__agentFeedDeliver?.(frame);

  const answer = (rid: string, method: string, path: string) => {
    const answered = route(method, path);
    if (!answered) {
      deliver({ t: "agent-http-head", rid, status: 404 });
      deliver({
        t: "agent-http-chunk",
        rid,
        seq: 0,
        data: JSON.stringify({ error: { code: "not-found", message: `no fixture for ${path}` } }),
        complete: true,
      });
      deliver({ t: "agent-http-end", rid });
      return;
    }
    setTimeout(() => {
      if (!open.has(rid)) return;
      deliver({ t: "agent-http-head", rid, status: answered.status });
    }, 10);
    let sequence = 0;
    for (const message of answered.messages) {
      const seq = sequence++;
      setTimeout(() => {
        if (!open.has(rid)) return;
        deliver({ t: "agent-http-chunk", rid, seq, data: message.payload, complete: true });
      }, message.delay);
    }
    const last = answered.messages.at(-1)?.delay ?? 10;
    if (answered.heartbeat) {
      const { payload, intervalMs } = answered.heartbeat;
      // Started after the script so a beat never takes a sequence number ahead of a scripted
      // message still waiting on its delay: the relay fails a transfer on any gap.
      setTimeout(() => {
        const beat = setInterval(() => {
          if (!open.has(rid)) {
            clearInterval(beat);
            return;
          }
          deliver({ t: "agent-http-chunk", rid, seq: sequence++, data: payload, complete: true });
        }, intervalMs);
      }, last + 5);
    }
    if (answered.keepOpen) return;
    setTimeout(() => {
      if (!open.delete(rid)) return;
      deliver({ t: "agent-http-end", rid });
    }, last + 5);
  };

  (
    window as Window & {
      webkit: {
        messageHandlers: { agentFeed: { postMessage: (message: unknown) => void } };
      };
    }
  ).webkit = {
    messageHandlers: {
      agentFeed: {
        postMessage: (message: unknown) => {
          const frame = message as { t?: string; rid?: string; method?: string; path?: string };
          if (!frame.rid) return;
          if (frame.t === "agent-http-cancel") {
            open.delete(frame.rid);
            return;
          }
          if (frame.t !== "agent-http-req" || !frame.path) return;
          open.add(frame.rid);
          answer(frame.rid, frame.method ?? "GET", frame.path);
        },
      },
    },
  };
}
