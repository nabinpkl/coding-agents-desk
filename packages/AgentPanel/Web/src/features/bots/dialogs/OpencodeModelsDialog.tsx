import { ChevronDown, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { OpencodeModel } from "@/features/activity-feed/data-source/SidecarAgentSessions";

/**
 * Picking an opencode session's model, with its context window and price beside each entry.
 *
 * An anchored menu inside the composer band, not a modal: it rises from the footer cluster
 * that holds its switcher -- a narrow drop-up over the field and transcript -- and closes on
 * choose, Escape, or a click outside.
 * The slash args arrive as the initial filter, so `/models spark` opens already narrowed.
 * Choosing switches through the sidecar; the new model lands on the session event like a
 * rename, which is what moves the meter without a second read.
 */
export function OpencodeModelsDialog({
  models,
  current,
  initialFilter,
  onClose,
  onSwitch,
}: {
  /** Every model the serve offers, or null while the list is still loading. */
  models: readonly OpencodeModel[] | null;
  /** The session's current model as `providerID/modelID`, or null while unknown. */
  current: string | null;
  /** The slash args the menu was opened with, as its starting filter. */
  initialFilter: string;
  onClose: () => void;
  onSwitch: (model: OpencodeModel) => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!models) return;
    setFilter(initialFilter);
    setPendingName(null);
    setError(null);
  }, [models, initialFilter]);

  const shown = useMemo(() => {
    if (!models) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) =>
      `${model.name} ${model.modelID} ${model.providerID}`.toLowerCase().includes(needle),
    );
  }, [models, filter]);

  const currentProvider = current?.split("/")[0];
  // Sections the session is not on start collapsed, so the menu opens on the provider that
  // matters and the rest are one tap away instead of seventy rows of scroll. Typing a filter
  // expands everything: a hidden match is a missing match.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    if (!models || !currentProvider) return new Set();
    return new Set(models.map((model) => model.providerID).filter((provider) => provider !== currentProvider));
  });

  // Grouped by provider, the session's own first and the rest alphabetical: seventy flat
  // rows all shaped `name · provider/id` scan as one list, while sections answer "what else
  // does THIS provider offer" first. Serve order holds inside a section.
  const groups = useMemo(() => {
    const byProvider = new Map<string, OpencodeModel[]>();
    for (const model of shown) {
      const list = byProvider.get(model.providerID);
      if (list) list.push(model);
      else byProvider.set(model.providerID, [model]);
    }
    return [...byProvider.entries()]
      .sort(([a], [b]) => {
        if (a === currentProvider) return -1;
        if (b === currentProvider) return 1;
        return a.localeCompare(b);
      })
      .map(([provider, entries]) => ({ provider, entries }));
  }, [shown, current]);

  if (!models) return null;

  const choose = async (model: OpencodeModel) => {
    if (pendingName) return;
    setPendingName(`${model.providerID}/${model.modelID}`);
    setError(null);
    try {
      await onSwitch(model);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
      setPendingName(null);
    }
  };

  return (
    <>
      {/* Transparent, so the transcript shows through; it exists only to catch the click that
          lands outside the menu. Inside the band's stacking context, so it covers the card. */}
      <div
        aria-hidden
        className="fixed inset-0 z-40 cursor-default"
        onClick={() => {
          if (!pendingName) onClose();
        }}
      />
      <div
        role="dialog"
        aria-label="Switch model"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pendingName) onClose();
        }}
        className="absolute bottom-full left-0 z-50 mb-2 flex max-h-80 w-80 max-w-full flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card p-3 text-foreground shadow-2xl"
      >
        <input
          autoFocus
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter models…"
          aria-label="Filter models"
          className="min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain" role="listbox" aria-label="Models this serve offers">
          {groups.map(({ provider, entries }) => {
            // A typed filter expands everything it matches: a hidden match is a missing match.
            const isCollapsed = filter.trim() === "" && collapsed.has(provider);
            const groupId = `opencode-models-${provider}`;
            return (
              <li key={provider} role="presentation" className="pb-1">
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  aria-controls={groupId}
                  onClick={() => {
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(provider)) next.delete(provider);
                      else next.add(provider);
                      return next;
                    });
                  }}
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-3 pb-0.5 pt-2 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <ChevronDown
                    aria-hidden
                    className={`size-3.5 shrink-0 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {provider} · {entries.length}
                    {provider === currentProvider ? " · current" : ""}
                  </span>
                </button>
                {!isCollapsed ? (
                  <ul role="group" aria-label={provider} id={groupId}>
                    {entries.map((model) => {
                      const key = `${model.providerID}/${model.modelID}`;
                      const isCurrent = current !== null && current === key;
                      const pending = pendingName === key;
                      return (
                        <li key={key}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={isCurrent}
                            disabled={pendingName !== null}
                            onClick={() => void choose(model)}
                            className="flex w-full cursor-pointer items-baseline gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-accent disabled:cursor-not-allowed"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate font-mono text-sm text-foreground">
                                {model.name}
                                {isCurrent ? <span className="text-muted-foreground"> · current</span> : null}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {model.modelID}
                                {model.contextLimit !== null ? ` · ${(model.contextLimit / 1048576).toFixed(model.contextLimit % 1048576 === 0 ? 0 : 1)}M context` : ""}
                                {model.inputCost !== null && model.outputCost !== null
                                  ? ` · $${model.inputCost}/$${model.outputCost} per MTok`
                                  : ""}
                              </span>
                            </span>
                            {pending ? <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden /> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
            </li>
            );
          })}
        </ul>
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No models match that filter.</p>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      </div>
    </>
  );
}

/**
 * The models menu the composer's switcher button or `/models` opened: its starting filter and
 * the ways to close it or switch through it. One object so the composer passes it through as
 * a single prop.
 */
export interface OpencodeModelsMenu {
  filter: string;
  onClose: () => void;
  onSwitch: (providerID: string, modelID: string) => Promise<void>;
}

/**
 * The menu with its list: loads the models on open, marks the session's current one, and closes
 * on a successful switch. A failed list is a closed menu rather than an empty one -- an empty
 * list reads as "this serve offers nothing", which is never true.
 *
 * The current model arrives as a name rather than as usage, on purpose: usage blanks across the
 * post-compaction gap while the model survives it, and after a switch the meter holds the
 * previous reading until the next turn -- measured 2026-09-26, a dialog that marked the old
 * model current after the footer had already moved on.
 */
export function OpencodeModelsHost({
  feed,
  current,
  initialFilter,
  onClose,
  onSwitch,
}: {
  feed: SidecarDataSource;
  /** The session's current model as `providerID/modelID`, or null while unknown. */
  current: string | null;
  initialFilter: string;
  onClose: () => void;
  onSwitch: (providerID: string, modelID: string) => Promise<void>;
}) {
  const [models, setModels] = useState<readonly OpencodeModel[] | null>(null);
  useEffect(() => {
    let live = true;
    feed.listOpencodeModels().then(
      (list) => {
        if (live) setModels(list);
      },
      () => {
        if (live) onClose();
      },
    );
    return () => {
      live = false;
    };
  }, [feed, onClose]);

  if (!models) return null;
  return (
    <OpencodeModelsDialog
      models={models}
      current={current}
      initialFilter={initialFilter}
      onClose={onClose}
      onSwitch={async (model) => {
        await onSwitch(model.providerID, model.modelID);
        onClose();
      }}
    />
  );
}
