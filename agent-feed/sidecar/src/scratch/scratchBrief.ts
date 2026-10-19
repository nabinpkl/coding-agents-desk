// What a scratch chat's agent is told before the person's first message, and what the chat is
// called.
//
// The brief is the whole of the chat's setup: there is no instructions file in its folder, so a
// one-off question leaves nothing behind but the transcript. It rides at the front of the first
// message (`withScratchBrief`), which keeps it in the transcript for every later resume.

import { withScratchBrief } from "@agentdesk/agent-feed-wire";
import { projectsHome } from "@/scratch/scratchConfig";

/** A chat's name is cut here, at a word, so a list row shows the start of what was asked. */
const TITLE_CHARACTERS = 60;

/** The brief, for an agent starting in `folder`. */
export function scratchBrief(folder: string): string {
  // One line per paragraph: the panel shows it as written, so a line broken here is broken there.
  return [
    `This chat was started from Agent Desk with no project chosen. You are in a folder made for this chat alone, ${folder}, which starts empty.`,
    "What follows may be something to think through, a one-off task, or the start of a project. Talk first, and create files only when the work needs them. Files a one-off needs go in this folder.",
    `If the work turns out to be a project that should outlive this chat, say so and propose a name for it under ${projectsHome()}. Create it there only once the person agrees, and work there from then on.`,
  ].join("\n\n");
}

/** The first message a scratch chat is started with. */
export function scratchFirstTurn(folder: string, prompt: string): string {
  return withScratchBrief(scratchBrief(folder), prompt);
}

/**
 * The chat's name, from the first line of what was typed.
 *
 * A Claude session needs its name before it starts (`-n` is its address), and the message is all
 * there is to name it from. The agent can rename it once it knows what the chat is about.
 */
export function scratchTitle(prompt: string): string {
  const line =
    prompt
      .split(/\r?\n/)
      .map((part) => part.replace(/\s+/g, " ").trim())
      .find((part) => part.length > 0) ?? "";
  if (!line) return "Chat";
  if (line.length <= TITLE_CHARACTERS) return line;
  const cut = line.slice(0, TITLE_CHARACTERS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > TITLE_CHARACTERS / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
