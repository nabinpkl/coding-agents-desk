// Where the panel's composer keeps its files: the images it drops into a pane, and what the
// handles it leaves in a box stand for. Both under the per-user runtime root, beside each other.

import { join, resolve } from "node:path";
import { runtimePaths } from "@repo/tools/runtime-paths.mjs";
import { directoryEnvironment } from "@/config/configEnvironment";

// Where an image dropped into the panel's composer is written for the pane's Claude to read.
//
// Under the per-user runtime root rather than a shared or temporary directory, because the pane
// and the sidecar are always the same login session -- the pane is resolved out of THIS user's
// `~/.claude/sessions` -- so 0700 is exactly the right reach. `composerImages.ts` sweeps it.
export const composerImageDirectory = directoryEnvironment(
  "AGENT_FEED_COMPOSER_IMAGE_DIR",
  join(runtimePaths().root, "agent-panel", "composer-images"),
);

// What each `[Pasted text #N]` and `[Image #N]` the panel put in a composer stands for, kept
// across a sidecar restart -- the live sidecar restarts on every edit to its own tree, and a
// message being written at that moment would otherwise lose its paste or its picture on the next
// correction. Beside the images, with the same 0700 reach: it holds what people pasted.
export const composerHandlesPath = resolve(
  process.env.AGENT_FEED_COMPOSER_HANDLES_PATH?.trim()
    || join(runtimePaths().root, "agent-panel", "composer-handles.json"),
);
