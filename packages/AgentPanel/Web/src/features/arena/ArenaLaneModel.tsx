// A lane's model: the button that names it and the menu it opens. An opencode lane picks from the
// serve's own list; a Claude lane from the CLI's aliases, or a full model id typed into the menu.

import { useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { OpencodeModel } from "@/features/activity-feed/data-source/SidecarAgentSessions";
import { OpencodeModelsDialog, OpencodeModelsHost } from "@/features/bots/dialogs/OpencodeModelsDialog";
import type { ArenaContestantSource } from "@agentdesk/agent-feed-wire";
import { FOCUS, ICON_BUTTON, TEXT } from "@/features/arena/arenaVocabulary";

/** The lane model control's look. */
const MODEL_CONTROL = `min-h-8 w-full rounded-md border border-input bg-background px-2 py-1 font-mono ${TEXT.meta} text-foreground transition-colors ${FOCUS}`;

/**
 * What a Claude lane offers: the CLI's own aliases, which follow each family's latest model, so
 * the list does not age with every release. A full model id is typed into the menu's filter.
 */
const CLAUDE_MODELS: readonly OpencodeModel[] = [
  ["best", "Best available"],
  ["fable", "Fable"],
  ["opus", "Opus"],
  ["sonnet", "Sonnet"],
  ["haiku", "Haiku"],
  ["opusplan", "Opus to plan, Sonnet to build"],
].map(([modelID, name]) => ({
  providerID: "claude",
  modelID: modelID!,
  name: name!,
  contextLimit: null,
  inputCost: null,
  outputCost: null,
}));

/**
 * A lane's model: a button naming it, which opens the model menu under it, and a clear that puts
 * the lane back on its harness's default. An opencode lane's menu is the serve's own list, read when
 * it opens; a Claude lane's is the CLI's aliases, and takes a full id typed into its filter.
 */
export function LaneModel({
  feed,
  source,
  lane,
  model,
  onModel,
}: {
  feed: SidecarDataSource;
  source: ArenaContestantSource;
  lane: number;
  /** As the harness spells it (`providerID/modelID` for opencode); empty for the default. */
  model: string;
  onModel: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const label = `Contestant ${lane}'s model`;
  return (
    <div className="relative flex items-center gap-1">
      <button
        type="button"
        aria-label={`Contestant ${lane} model`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={model || "The harness's default model"}
        onClick={() => setOpen((was) => !was)}
        // The border, not the fill, answers the pointer: a filled hover held the muted
        // "Default model" under 4.5:1.
        className={`${MODEL_CONTROL} flex min-w-0 items-center gap-1 text-left hover:border-ring aria-expanded:border-ring`}
      >
        <span className={`min-w-0 flex-1 truncate ${model ? "" : "text-muted-foreground"}`}>
          {model || "Default model"}
        </span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </button>
      {model ? (
        <button
          type="button"
          aria-label={`Contestant ${lane} on the default model`}
          title="Back to the default model"
          onClick={() => onModel("")}
          className={`${ICON_BUTTON} size-8`}
        >
          <X aria-hidden className="size-4" />
        </button>
      ) : null}
      {open && source === "opencode" ? (
        <OpencodeModelsHost
          feed={feed}
          current={model || null}
          initialFilter=""
          label={label}
          placement="below"
          onClose={close}
          onSwitch={async (providerID, modelID) => onModel(`${providerID}/${modelID}`)}
        />
      ) : null}
      {open && source === "claude" ? (
        <OpencodeModelsDialog
          models={CLAUDE_MODELS}
          current={model ? `claude/${model}` : null}
          initialFilter=""
          label={label}
          listLabel="Claude's model aliases"
          placement="below"
          onClose={close}
          onSwitch={async ({ modelID }) => {
            onModel(modelID);
            close();
          }}
          onCustom={async (text) => {
            onModel(text);
            close();
          }}
        />
      ) : null}
    </div>
  );
}
