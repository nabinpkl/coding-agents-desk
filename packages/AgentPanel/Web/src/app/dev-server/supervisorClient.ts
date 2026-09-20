// What each machine's sidecar supervisor is doing, and how the reader's choice gets back to it.
//
// A supervisor serves nothing: it owns the sidecar as a child, so the only process on that machine
// with a port is the child itself. That shapes both directions here. Its STATE rides back on
// `/api/config`, which this server already asks every sidecar for on a timer to see whether it is
// alive, so a peer's held tree costs no request of its own. Its COMMANDS go the same way in
// reverse, to `/api/supervisor`, where the sidecar leaves them on the board its parent is watching.
//
// It lives here rather than in `vite.config.ts` because it is the half of that file with decisions
// in it, and because a peer answering an enormous body or never answering at all are the cases
// worth having in front of a reader rather than buried in a config.

import { request as httpRequest } from "node:http";

/** Whether a supervisor takes a tree that parses at once, or waits to be asked. */
export type SupervisorMode = "auto" | "manual";

/** Setting a machine's mode, or asking it to take the tree it is sitting on. */
export type SupervisorCommand = SupervisorMode | "apply";

/** One machine this panel can reach, by the label its reader knows it by. */
export interface Machine {
  label: string;
  host: string;
  port: number;
}

/** One machine's supervisor, as this server last heard it. */
export interface MachineSupervisor {
  held: boolean;
  blocked: string | null;
  mode: SupervisorMode;
}

/** Bodies from another machine, bounded: the part that matters is a few hundred bytes. */
const MAX_BODY = 64_000;

/** Long enough for a peer over the tailnet, short enough that a dead one is not a stuck poll. */
const TIMEOUT_MS = 4_000;

export function createSupervisorClient() {
  /**
   * Keyed by label, replaced on every answer and deleted when a machine stops answering, so nothing
   * in here outlives the thing it describes.
   */
  const supervisors = new Map<string, MachineSupervisor>();

  const read = (machine: Machine, onChange: () => void): void => {
    ask(machine, "GET", "/api/config", null, (body) => {
      const before = JSON.stringify(supervisors.get(machine.label) ?? null);
      const status = body === null ? null : (body as { supervisor?: unknown }).supervisor;
      if (status && typeof status === "object") {
        const { held, blocked, mode } = status as Record<string, unknown>;
        supervisors.set(machine.label, {
          held: held === true,
          blocked: typeof blocked === "string" ? blocked : null,
          mode: mode === "manual" ? "manual" : "auto",
        });
      } else {
        supervisors.delete(machine.label);
      }
      if (JSON.stringify(supervisors.get(machine.label) ?? null) !== before) onChange();
    });
  };

  return {
    /**
     * Re-read every machine, forgetting the ones no longer on the list.
     *
     * The whole list each time rather than a subscription, because the state that matters most is a
     * supervisor that STOPPED, and a process that died produces no event anywhere.
     */
    refresh(machines: Machine[], onChange: () => void): void {
      const known = new Set(machines.map((machine) => machine.label));
      for (const label of [...supervisors.keys()]) {
        if (!known.has(label) && supervisors.delete(label)) onChange();
      }
      for (const machine of machines) read(machine, onChange);
    },

    /** What to put on the panel's report: one entry per machine still answering. */
    report(): { machine: string; held: boolean; blocked: string | null; mode: SupervisorMode }[] {
      return [...supervisors].map(([machine, status]) => ({ machine, ...status }));
    },

    /**
     * Pass the reader's choice to every machine at once.
     *
     * One switch covers the panel and every sidecar behind it, because what a reader means by
     * manual is "stop changing under me" rather than a per-process preference. A machine already in
     * the asked-for mode does nothing with it, so repeating one costs a few hundred bytes.
     */
    tell(machines: Machine[], command: SupervisorCommand): void {
      for (const machine of machines) {
        ask(machine, "POST", "/api/supervisor", { command }, () => {});
      }
    },
  };
}

/** One request to one machine, answered with its parsed body or null if it could not be had. */
function ask(
  machine: Machine,
  method: "GET" | "POST",
  path: string,
  body: unknown,
  done: (answer: unknown) => void,
): void {
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  const probe = httpRequest(
    {
      host: machine.host,
      port: machine.port,
      method,
      path,
      timeout: TIMEOUT_MS,
      headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
    },
    (answer) => {
      if (answer.statusCode !== 200) {
        answer.resume();
        done(null);
        return;
      }
      let text = "";
      answer.setEncoding("utf8");
      answer.on("data", (chunk: string) => {
        if (text.length < MAX_BODY) text += chunk;
      });
      answer.on("end", () => {
        try {
          done(JSON.parse(text));
        } catch {
          done(null);
        }
      });
    },
  );
  probe.on("timeout", () => probe.destroy());
  // Unreachable, which for a peer that is simply off is the ordinary case. The machine list ages it
  // out on its own clock, and logging every tick would drown the server's log.
  probe.on("error", () => done(null));
  if (payload) probe.write(payload);
  probe.end();
}
