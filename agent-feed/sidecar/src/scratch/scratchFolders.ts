// One folder per scratch chat: made when its first message is sent, named from that message.
//
// A folder each, not one shared, so chats running side by side never see each other's files. Made
// only once there is a message to start the chat with, so a Chat box closed unsent leaves nothing
// on disk, and removed again only by the start that made it and only while still empty.

import { randomBytes } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { scratchRoot } from "@/scratch/scratchConfig";

/** How long the readable part of a folder's name may be, before its random suffix. */
const SLUG_CHARACTERS = 40;
/** Tries at a free name before giving up; a clash needs the same title and the same suffix. */
const NAME_ATTEMPTS = 5;

/** Whether a session's folder is a scratch chat's. */
export function isScratchFolder(path: string): boolean {
  return dirname(path) === scratchRoot();
}

/** The readable part of a folder's name: the title's words, lower case, joined by hyphens. */
export function scratchSlug(title: string): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!words) return "chat";
  if (words.length <= SLUG_CHARACTERS) return words;
  const cut = words.slice(0, SLUG_CHARACTERS);
  const lastBreak = cut.lastIndexOf("-");
  return (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).replace(/-+$/, "");
}

/**
 * Makes a new, empty folder for one chat and answers its path.
 *
 * Made without `recursive`, so making it is what claims the name: two chats with the same title
 * started at once cannot both land in one folder.
 */
export async function makeScratchFolder(title: string, root: string = scratchRoot()): Promise<string> {
  await mkdir(root, { recursive: true });
  const slug = scratchSlug(title);
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const path = join(root, `${slug}-${randomBytes(2).toString("hex")}`);
    try {
      await mkdir(path);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`no free scratch folder name for "${slug}" after ${NAME_ATTEMPTS} tries`);
}

/**
 * Removes a folder `makeScratchFolder` made, for a start that failed after making it.
 *
 * `rmdir`, not a recursive remove: it refuses a folder that has anything in it, so whatever got
 * written there by the time this runs stays put rather than being deleted on a guess.
 */
export async function removeScratchFolder(path: string, root: string = scratchRoot()): Promise<void> {
  if (dirname(path) !== root) throw new Error(`${path} is not a scratch folder under ${root}`);
  await rmdir(path);
}
