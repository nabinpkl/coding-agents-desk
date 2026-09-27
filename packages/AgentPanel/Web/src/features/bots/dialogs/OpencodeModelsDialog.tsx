import { LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { SidecarDataSource } from "@/features/activity-feed/data-source/SidecarDataSource";
import type { TokenUsage } from "@/features/activity-feed/useSessionEventsStream";
import type { OpencodeModel } from "@/features/activity-feed/data-source/SidecarAgentSessions";

/**
 * Picking an opencode session's model, with its context window and price beside each entry.
 *
 * App-level for `SessionRenameDialog`'s reason: the menu renders on the sidebar and on the
 * canvas, and the canvas one sits inside a card that scrolls sideways. The slash args arrive
 * as the initial filter, so `/models spark` opens already narrowed. Choosing switches
 * through the sidecar; the new model lands on the session event like a rename, which is
 * what moves the meter without a second read.
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
  /** The slash args the dialog was opened with, as its starting filter. */
  initialFilter: string;
  onClose: () => void;
  onSwitch: (model: OpencodeModel) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [filter, setFilter] = useState("");
  const [pendingName, setPendingName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!models) return;
    setFilter(initialFilter);
    setPendingName(null);
    setError(null);
  }, [models, initialFilter]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !models || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }, [models]);

  const shown = useMemo(() => {
    if (!models) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((model) =>
      `${model.name} ${model.modelID} ${model.providerID}`.toLowerCase().includes(needle),
    );
  }, [models, filter]);

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

  const close = (event: FormEvent) => {
    event.preventDefault();
    if (!pendingName) onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="opencode-models-title"
      className="fixed inset-0 z-60 m-0 h-dvh max-h-none w-screen max-w-none items-center justify-center border-0 bg-transparent p-4 text-foreground backdrop:bg-black/45 open:flex"
      onCancel={(event) => {
        event.preventDefault();
        if (!pendingName) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pendingName) onClose();
      }}
    >
      <form
        onSubmit={close}
        className="flex max-h-[80dvh] w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-card p-4 text-foreground shadow-2xl"
      >
        <h2 id="opencode-models-title" className="text-base font-semibold">Switch model</h2>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter models…"
          aria-label="Filter models"
          className="min-h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
        <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="listbox" aria-label="Models this serve offers">
          {shown.map((model) => {
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
                      {model.providerID}/{model.modelID}
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
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">No models match that filter.</p>
        ) : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex items-center justify-end gap-2">
          <button
            type="submit"
            disabled={pendingName !== null}
            className="min-h-10 rounded-lg px-4 text-sm font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary active:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * The dialog with its list: loads the models on open, marks the session's current one from
 * its usage, and closes on a successful switch. A failed list is a closed dialog rather than
 * an empty one -- an empty list reads as "this serve offers nothing", which is never true.
 */
export function OpencodeModelsHost({
  feed,
  usage,
  initialFilter,
  onClose,
  onSwitch,
}: {
  feed: SidecarDataSource;
  usage: TokenUsage | null;
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
      current={usage?.model ?? null}
      initialFilter={initialFilter}
      onClose={onClose}
      onSwitch={async (model) => {
        await onSwitch(model.providerID, model.modelID);
        onClose();
      }}
    />
  );
}
