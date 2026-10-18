// Creating an opencode session on this machine's serve, with the permission rules it must hold.
//
// Not the pool's: a create is a single remote call that owns none of the pool's state, and the
// session is the pool's only from its first `open`. Its own file because the one rule it has is
// about the rules: a session that comes back without them is removed before anyone can use it.

import type { OpencodeClient } from "@/agents/opencode/serve/opencodeClient";

/** One serve permission rule. Of those matching an action and resource, the last decides. */
export interface OpencodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

/** The serve's id and title for a session it just made in `projectPath`. */
export async function createOpencodeSession(
  client: OpencodeClient | null,
  projectPath: string,
  permissions: readonly OpencodePermissionRule[] | undefined,
): Promise<{ sessionId: string; title: string }> {
  if (!client) throw new Error("opencode serve password is not configured");
  const created = await client.session.create({
    location: { directory: projectPath },
    ...(permissions ? { permissions } : {}),
  });
  if (typeof created.id !== "string" || !created.id) throw new Error("opencode created a session without an id");
  // Rules that did not arrive leave a session running as its agent, which is everything the
  // rules were there to refuse. The old client dropped this very field without an error, so
  // the stored rules are checked against the asked-for ones, and a mismatch removes the
  // session before anything can use it rather than handing it on unconfined.
  if (permissions && !sameRules(created.permissions, permissions)) {
    await client.session.remove({ sessionID: created.id }).catch(() => {});
    throw new Error("opencode created the session without the rules it was asked to hold");
  }
  return { sessionId: created.id, title: created.title || created.id };
}

/** The same rules in the same order: order is meaning here, since the last match decides. */
function sameRules(
  stored: readonly OpencodePermissionRule[] | undefined,
  asked: readonly OpencodePermissionRule[],
): boolean {
  if (!stored || stored.length !== asked.length) return false;
  return stored.every((rule, index) => {
    const other = asked[index];
    return rule.action === other?.action && rule.resource === other.resource && rule.effect === other.effect;
  });
}
