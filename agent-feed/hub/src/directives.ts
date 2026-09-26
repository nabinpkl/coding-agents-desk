// Directives: work a session asks the hub to have done on its machine, answered on its stream.
//
// Messages are the hub's store-and-forward half: accepted, queued, pumped, confirmed. A directive
// is the synchronous half: the MCP caller waits while the addressed session's sidecar runs it and
// confirms the outcome. The two share nothing but the stream they travel on, because their
// lifecycles differ -- a message waits for a run that returns, a directive refuses when nothing
// holds the stream right now.
//
// Only `rename-bracket` exists today: an opencode session renaming its own bracket task through
// the sidecar's completion route. The MCP handler proves the caller the way `hub_send` does
// (the sender guard: a live stream, its own machine, in a Bot), pushes the directive onto that
// live stream, and waits for the sidecar's confirm. The sidecar resolves the anchor and renames;
// the hub never knows either.

import { randomUUID } from "node:crypto";
import type { SessionAddress } from "@agentdesk/agent-feed-wire";
import type { Principal } from "@/config";
import { Forbidden, InvalidMessage, type Messages } from "@/messages";

export interface DirectiveDone {
  ok: boolean;
  anchor?: string;
  title?: string;
  status?: string;
  error?: string;
}

interface Pending {
  address: SessionAddress;
  machine: string;
  task: string;
  resolve: (done: DirectiveDone) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TASK_MAX = 256;
const WAIT_MS = 25_000;

export class Directives {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly messages: Messages,
    private readonly waitMs: number = WAIT_MS,
  ) {}

  /**
   * Runs one rename-bracket directive against an opencode session and answers what it did.
   *
   * Refuses before spending anything when the session may not act: no live stream, another
   * machine's, or in no Bot -- the sender guard, shared with sending. Refuses when nothing holds
   * the stream right now rather than queueing: a rename answered minutes later would land on a
   * title the reader has since changed by hand.
   */
  async renameBracket(principal: Principal, sessionId: string, task: string): Promise<DirectiveDone> {
    if (typeof task !== "string") throw new InvalidMessage("task must be a string");
    if (task.length > TASK_MAX) throw new InvalidMessage(`task must be at most ${TASK_MAX} characters`);
    if (/[\n\r]/.test(task)) throw new InvalidMessage("task cannot contain a line break");
    const address = `opencode:${sessionId}` as SessionAddress;
    const { machine } = this.messages.checkSession(principal, address);
    const id = randomUUID();
    const done = await new Promise<DirectiveDone>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "the sidecar did not answer in time" });
      }, this.waitMs);
      // Bun and node both clear these; a settled directive must not keep the process up.
      timer.unref?.();
      this.pending.set(id, { address, machine, task, resolve, timer });
      if (!this.messages.direct(address, { type: "directive", id, kind: "rename-bracket", task })) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({ ok: false, error: `${address} has no live stream right now` });
      }
    });
    return done;
  }

  /**
   * Records a sidecar's answer to its directive.
   *
   * Confirmed by the machine holding the stream, never by the session name alone: the pending
   * entry remembers which machine it was pushed to, and anything else is refused.
   */
  confirm(principal: Principal, id: string, done: DirectiveDone): { ok: true } {
    const waiting = this.pending.get(id);
    if (!waiting) throw new InvalidMessage(`no directive ${id} is waiting`);
    if (!principal.owner && principal.machine !== waiting.machine) {
      throw new Forbidden(`${principal.label} holds no stream for ${waiting.address}`);
    }
    clearTimeout(waiting.timer);
    this.pending.delete(id);
    waiting.resolve(done);
    return { ok: true as const };
  }

  /** For tests: how many directives are still waiting. */
  get waiting(): number {
    return this.pending.size;
  }
}
