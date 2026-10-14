// Which sessions a tool started on its own, rather than a person.
//
// One kind today, and it is most of the catalog: the `security-guidance` plugin (Claude's official
// marketplace) reviews every commit and every stopped turn by starting a second `claude` through
// the Python Agent SDK, and that session saves a transcript like any other. Measured 2026-10-14:
// 456 of agent-desk's 808 sessions, and 45 of its 60 most recent, were these.
//
// Named by how they were started, not by their title. The CLI gives them generated titles ("BotFace
// security review") that read exactly like a person's ("Review dictation panel security
// changes"), and some have no title at all. What no person's session carries is both of these at
// once: the Python SDK's `entrypoint`, which nothing else on this machine launches with (every one
// of 1,644 such transcripts was this plugin's), and one of the two prompts the plugin opens with --
// its review, and the second pass that adjudicates what the review flagged. Either alone would
// misfile: a Python SDK tool of the owner's own, or a person pasting the prompt into a terminal.

import type { SessionAutomation } from "@agentdesk/agent-feed-wire";
import type { Session } from "@/transcripts/transcriptTypes";

const PYTHON_SDK_ENTRYPOINT = "sdk-py";

/** The plugin's opening lines, as `compactTitle` leaves them: whitespace runs are one space. */
const SECURITY_REVIEW_PROMPTS = [
  "Review this change for security vulnerabilities.",
  "You previously flagged these candidate vulnerabilities:",
] as const;

export function sessionAutomation(session: Session): SessionAutomation | undefined {
  if (session.source !== "claude" || session.entrypoint !== PYTHON_SDK_ENTRYPOINT) return undefined;
  const prompt = session.firstPrompt;
  if (prompt && SECURITY_REVIEW_PROMPTS.some((opening) => prompt.startsWith(opening))) {
    return "security-review";
  }
  return undefined;
}
