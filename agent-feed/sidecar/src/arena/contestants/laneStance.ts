// What a lane's stance changes about how it is driven: the words around its prompt, and the tools
// it runs without. A `for` lane is driven exactly as every lane was before stances existed.
//
// The stance rides the prompt, not a harness's system prompt, so it is one mechanism for both
// harnesses and both modes: Claude has `--append-system-prompt`, but the opencode serve's send takes
// text alone. It is repeated with every prompt of the run, so a later prompt cannot read as the
// moment the lane stopped arguing, and it shows in the lane's transcript, so a reader sees exactly
// what the lane was told.
//
// The prompt is put after the note and runs to the end of the message, with no closing tag: a
// prompt that held the tag could otherwise end the envelope early.

import type { ArenaLaneStance } from "@agentdesk/agent-feed-wire";
import type { OpencodePermissionRule } from "@/agents/opencode/opencodeSessionCreate";

/**
 * Claude's file-editing tools. Removed from its context rather than refused at the call, so a
 * session without them never spends a turn trying one. Its shell stays, under the machine's own
 * permission mode, which is how it tests a claim.
 */
export const CLAUDE_EDIT_TOOLS: readonly string[] = ["Edit", "Write", "NotebookEdit"];

/**
 * An against lane's opencode rules, after its agent's: no edit of any file (the serve's `edit`
 * covers writing and patching too). Its shell is left to the serve's own rules, as any lane's is.
 */
export const AGAINST_OPENCODE_RULES: readonly OpencodePermissionRule[] = [
  { action: "edit", resource: "*", effect: "deny" },
];

const AGAINST_NOTE = [
  "You are the against lane of an arena run. Other sessions were given the prompt below and are doing it. " +
    "You will not see their work and they will not see yours, so argue against the idea itself, not " +
    "against anyone's attempt at it.",
  "",
  "Make the strongest honest case that this should not be done, or not done this way:",
  "- what it costs, what it risks, and what it breaks or makes harder later;",
  "- cheaper or simpler alternatives, doing nothing among them;",
  "- evidence from this repository: read the code, and name the files behind each point.",
  "",
  "Do not carry out the request, and do not edit any file. You may read files and run commands to " +
    "test a claim. Do not concede, and do not soften this into a balanced review: the other lanes make " +
    "the case for it. End with your single strongest objection, in one or two sentences.",
  "",
  "The prompt, which runs to the end of this message:",
  "",
  "",
].join("\n");

/** The text a lane of `stance` is sent for the run's `prompt`. */
export function promptForStance(stance: ArenaLaneStance, prompt: string): string {
  return stance === "against" ? `${AGAINST_NOTE}${prompt}` : prompt;
}
