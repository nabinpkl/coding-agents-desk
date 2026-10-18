import { ChevronDown, LoaderCircle } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { OpencodeModel } from "@/features/activity-feed/data-source/SidecarAgentSessions";
import { useDomSync } from "@/hooks/dom/useDomSync";
import { useStateFor } from "@/hooks/state/useStateFor";
import { sourceKey, usePanelQuery } from "@/query/panelQuery";

/**
 * Picking an opencode session's model, with its context window and price beside each entry.
 *
 * An anchored menu, not a modal: in the composer band it rises from the footer cluster that holds
 * its switcher -- a narrow drop-up over the field and transcript -- and under an arena lane's model
 * button it drops below it. It closes on choose, Escape, or a click outside.
 *
 * The list is whatever it is handed: the serve's models for opencode, or the aliases a Claude lane
 * offers. Given `onCustom`, a filter that names no listed model can be used as typed, which is how a
 * Claude lane takes a full model id the list does not hold.
 * The slash args arrive as the initial filter, so `/models spark` opens already narrowed.
 * Choosing switches through the sidecar; the new model lands on the session event like a
 * rename, which is what moves the meter without a second read.
 */
/**
 * Where the menu opens from its anchor: rising from the composer's footer, or dropping below a
 * control higher on the page, such as an arena lane's model button.
 */
export type OpencodeModelsPlacement = "above" | "below";

/**
 * A second choice beside the model, for a session whose model takes one: a Claude SDK session's
 * effort. Its levels are the current model's, least first; `current` null is the model's default.
 */
export interface ModelEffortChoice {
  levels: readonly string[];
  current: string | null;
  onChoose: (level: string) => Promise<void>;
}

const EFFORT_LABELS: Record<string, string> = { low: "Low", medium: "Med", high: "High", xhigh: "XHigh", max: "Max" };

const PLACEMENT_CLASS: Record<OpencodeModelsPlacement, string> = {
  above: "bottom-full mb-2 max-w-full",
  below: "top-full mt-2 max-w-[calc(100vw-2rem)]",
};

export function OpencodeModelsDialog({
  models,
  current,
  initialFilter,
  label = "Switch model",
  placement = "above",
  listLabel = "Models this serve offers",
  onClose,
  onSwitch,
  onCustom,
  effort,
}: {
  /** Every model the serve offers, or null while the list is still loading. */
  models: readonly OpencodeModel[] | null;
  /** The session's current model as `providerID/modelID`, or null while unknown. */
  current: string | null;
  /** The slash args the menu was opened with, as its starting filter. */
  initialFilter: string;
  /** What the menu is for, its accessible name. */
  label?: string;
  placement?: OpencodeModelsPlacement;
  /** What the list holds, its accessible name. */
  listLabel?: string;
  onClose: () => void;
  onSwitch: (model: OpencodeModel) => Promise<void>;
  /** Takes the filter as typed, when it names no listed model; absent, only the list can be chosen. */
  onCustom?: (text: string) => Promise<void>;
  /** The effort row under the list; absent where the model takes none. */
  effort?: ModelEffortChoice;
}) {
  // A new list, or a new starting filter, starts the dialog over.
  const listing = useMemo(() => ({ models, initialFilter }), [models, initialFilter]);
  const [filter, setFilter] = useStateFor(listing, () => initialFilter);
  const [pendingName, setPendingName] = useStateFor<string | null>(listing, () => null);
  const [error, setError] = useStateFor<string | null>(listing, () => null);
  const menu = useRef<HTMLDivElement>(null);

  // Dropped below a control lower on a page, the menu can open past the screen's bottom edge on a
  // phone, where nothing says it opened: it brings itself into view, scrolling only as far as that.
  useDomSync(() => {
    if (models && placement === "below") menu.current?.scrollIntoView?.({ block: "nearest" });
  }, [models, placement]);

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

  const typed = filter.trim();
  const custom = onCustom && typed && !models.some((model) => model.modelID === typed) ? typed : null;

  /** Runs one choice, holding the menu on it until it lands, and saying why when it does not. */
  const settle = async (pending: string, act: () => Promise<void>) => {
    if (pendingName) return;
    setPendingName(pending);
    setError(null);
    try {
      await act();
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
      setPendingName(null);
    }
  };
  const choose = (model: OpencodeModel) => settle(`${model.providerID}/${model.modelID}`, () => onSwitch(model));
  const takeCustom = (text: string) => settle(`custom:${text}`, () => onCustom!(text));
  // Stays open on success: an effort is set beside a model, often right after choosing one.
  const chooseEffort = (level: string) =>
    settle(`effort:${level}`, async () => {
      await effort!.onChoose(level);
      setPendingName(null);
    });

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
        ref={menu}
        role="dialog"
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !pendingName) onClose();
        }}
        className={`absolute left-0 z-50 ${PLACEMENT_CLASS[placement]} flex max-h-80 w-80 flex-col gap-2 overflow-hidden rounded-xl border border-border bg-card p-3 text-foreground shadow-2xl`}
      >
        <input
          autoFocus
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onKeyDown={(event) => {
            // Enter takes what was typed only when nothing listed matches it, so it never picks a
            // row the reader did not see chosen.
            if (event.key === "Enter" && custom && shown.length === 0) void takeCustom(custom);
          }}
          placeholder={onCustom ? "Filter, or type a model id…" : "Filter models…"}
          aria-label="Filter models"
          className="min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto overscroll-contain" role="listbox" aria-label={listLabel}>
          {custom ? (
            <li role="presentation" className="pb-1">
              <button
                type="button"
                role="option"
                aria-selected={false}
                disabled={pendingName !== null}
                onClick={() => void takeCustom(custom)}
                className="flex w-full cursor-pointer items-baseline gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring active:bg-accent disabled:cursor-not-allowed"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  Use <span className="font-mono">{custom}</span>
                </span>
                {pendingName === `custom:${custom}` ? <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden /> : null}
              </button>
            </li>
          ) : null}
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
        {shown.length === 0 && !custom ? (
          <p className="text-sm text-muted-foreground">No models match that filter.</p>
        ) : null}
        {effort ? (
          <div role="radiogroup" aria-label="Effort" className="flex items-center gap-2 border-t border-border pt-2">
            <span className="text-xs font-medium text-muted-foreground">Effort</span>
            <div className="flex min-w-0 flex-1 gap-0.5 rounded-lg bg-muted p-0.5">
              {effort.levels.map((level) => {
                const checked = effort.current === level;
                return (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={pendingName !== null}
                    onClick={() => {
                      if (!checked) void chooseEffort(level);
                    }}
                    className={`flex h-7 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-md px-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-60 ${
                      checked ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground active:bg-background/60"
                    }`}
                  >
                    {pendingName === `effort:${level}`
                      ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
                      : EFFORT_LABELS[level] ?? level}
                  </button>
                );
              })}
            </div>
          </div>
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
  label,
  placement,
  onClose,
  onSwitch,
}: {
  feed: SidecarDataSource;
  /** The session's current model as `providerID/modelID`, or null while unknown. */
  current: string | null;
  initialFilter: string;
  label?: string;
  placement?: OpencodeModelsPlacement;
  onClose: () => void;
  onSwitch: (providerID: string, modelID: string) => Promise<void>;
}) {
  // A list that cannot be read closes the dialog rather than opening an empty one.
  const listed = usePanelQuery({
    queryKey: ["opencode-models", sourceKey(feed)],
    queryFn: () => feed.listOpencodeModels().catch((cause: unknown) => {
      onClose();
      throw cause;
    }),
  });
  const models = listed.data ?? null;

  if (!models) return null;
  return (
    <OpencodeModelsDialog
      models={models}
      current={current}
      initialFilter={initialFilter}
      label={label}
      placement={placement}
      onClose={onClose}
      onSwitch={async (model) => {
        await onSwitch(model.providerID, model.modelID);
        onClose();
      }}
    />
  );
}
