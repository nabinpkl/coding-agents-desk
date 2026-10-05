// Which pool of names this machine gives its Bot sessions.
//
// Imported by its callers directly rather than through `config.ts`, which is the convention for
// this directory, because `config.ts` sits at the 500-line cap and this is one value.
//
// One pool per machine, set once when the machine is set up: this Mac uses the default, and
// `tools/remote-sidecar.sh` starts each peer on its own. A name it does not know refuses to start
// the sidecar, because a silent fallback to the default would put two machines on one pool -- the
// clash the pools exist to prevent, and one nothing else would report.

import { ANCHOR_POOLS } from "@agentdesk/agent-feed-wire";

export function anchorPoolNamed(name: string | undefined): readonly string[] {
  const chosen = name?.trim() || "people";
  const pool = ANCHOR_POOLS[chosen];
  if (!pool) {
    throw new Error(
      `AGENT_FEED_ANCHOR_POOL is "${chosen}", which is not one of ${Object.keys(ANCHOR_POOLS).join(", ")}`,
    );
  }
  return pool;
}

export const anchorPool = anchorPoolNamed(process.env.AGENT_FEED_ANCHOR_POOL);
