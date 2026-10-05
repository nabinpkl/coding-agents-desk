// One mirrored pane, rendered, with the fake stream behind it.
//
// A module rather than a copy per file: `pane` stands up the feed the hook subscribes
// to, `Probe` renders the hook's own controls, and the typing helpers exist because
// every push is debounced behind fake timers.

import { act, fireEvent, screen, render } from "@testing-library/react";
import { vi } from "vitest";
import type { RailKey, RailModifiers, TmuxComposerState } from "@agentdesk/agent-feed-wire";
import type { SessionAddress } from "@/features/activity-feed/data-source/SidecarDataSource";
import { useTmuxComposer } from "@/features/cli-input/useTmuxComposer";

export const SESSION: SessionAddress = { source: "claude", sessionId: "s1" };

export function holding(text: string, wrapped = false, hint: string | null = null): TmuxComposerState {
  return { text, hint, reason: null, exact: !wrapped, commands: [], pastes: [], images: [] };
}

/**
 * A pane whose composer this test drives directly, standing in for the sidecar and tmux.
 *
 * `emit` is what the sidecar's watcher does when the pane writes. Nothing is on a timer here for
 * the same reason nothing is in the hook: the pane speaks, or it does not.
 */
export function pane(initial = "", opening?: TmuxComposerState) {
  let listener: ((state: TmuxComposerState) => void) | null = null;
  const feed = {
    box: initial,
    subscribes: 0,
    live: false,
    pushes: [] as string[],
    submits: 0,
    accepts: 0,
    /**
     * The size of each image handed over, in the order the pane would number them.
     *
     * Sizes rather than contents: reading a `Blob` is asynchronous in a way fake timers do not
     * drive, and what this test is about is which image arrives first.
     */
    drops: [] as number[],
    /** Sends one state to whoever is subscribed, as the pane writing would. */
    emit(state: TmuxComposerState) {
      listener?.(state);
    },
    /** Sends what the box now holds, which is the ordinary case. */
    announce(wrapped = false) {
      feed.emit(holding(feed.box, wrapped));
    },
    subscribeTmuxComposer(
      _session: SessionAddress,
      handlers: { onComposer?: (state: TmuxComposerState) => void },
    ): () => void {
      feed.subscribes += 1;
      feed.live = true;
      listener = handlers.onComposer ?? null;
      listener?.(opening ?? holding(feed.box));
      return () => {
        feed.live = false;
        listener = null;
      };
    },
    syncTmuxComposer: async (_session: SessionAddress, text: string): Promise<TmuxComposerState> => {
      feed.pushes.push(text);
      feed.box = text;
      return holding(text);
    },
    submitTmuxComposer: async (): Promise<TmuxComposerState> => {
      feed.submits += 1;
      feed.box = "";
      return holding("");
    },
    acceptTmuxComposerHint: async (): Promise<TmuxComposerState> => {
      feed.accepts += 1;
      return { text: null, hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] };
    },
    /** Every rail press, so a test can ask what reached the pane and what was held when it did. */
    keys: [] as { key: RailKey; modifiers: RailModifiers }[],
    pressTmuxComposerKey: async (
      _session: SessionAddress,
      key: RailKey,
      modifiers: RailModifiers,
    ): Promise<TmuxComposerState> => {
      feed.keys.push({ key, modifiers });
      return { text: null, hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] };
    },
    /**
     * What the sidecar is holding for each handle, so a test can make a chip openable or not.
     *
     * Keyed by the handle itself rather than by its number, because Claude writes two spellings
     * for the same paste -- `[Pasted text #1]` and `[Pasted text #1 +38 lines]` -- and only the
     * box says which one it used.
     */
    held: new Map<string, string>(),
    /** Every handle a preview was asked for, so a test can say the fetch happened once. */
    previewed: [] as string[],
    readTmuxComposerPaste: async (_session: SessionAddress, token: string) => {
      feed.previewed.push(token);
      return feed.held.get(token) ?? null;
    },
    dropTmuxComposerImage: async (
      _session: SessionAddress,
      image: Blob,
    ): Promise<TmuxComposerState> => {
      feed.drops.push(image.size);
      return { text: null, hint: null, reason: null, exact: true, commands: [], pastes: [], images: [] };
    },
  };
  return feed;
}

export function Probe({ feed, active = true }: { feed: ReturnType<typeof pane>; active?: boolean }) {
  const composer = useTmuxComposer(feed, SESSION, active);
  return (
    <div>
      <span data-testid="draft">{composer.draft}</span>
      <span data-testid="mirrored">{String(composer.mirrored)}</span>
      <span data-testid="paned">{String(composer.paned)}</span>
      <span data-testid="reason">{composer.reason ?? "-"}</span>
      <span data-testid="hint">{composer.hint ?? "-"}</span>
      <span data-testid="images">
        {composer.images.map((image) => `${image.id}:${image.url ?? "none"}`).join(" ")}
      </span>
      <input
        aria-label="composer"
        value={composer.draft}
        onChange={(event) => composer.change(event.target.value)}
        onBlur={composer.onBlur}
        placeholder={composer.hint ?? "Type into Claude's terminal…"}
      />
      <button type="button" onClick={() => void composer.accept()}>accept</button>
      <span data-testid="modifiers">
        {(["ctrl", "alt", "shift"] as const).map((m) => `${m}:${composer.modifiers[m]}`).join(" ")}
      </span>
      <button type="button" onClick={() => composer.toggleModifier("ctrl")}>ctrl</button>
      <button type="button" onClick={() => composer.pressKey("escape")}>escape</button>
      <button type="button" onClick={() => composer.pressKey("left")}>left</button>
      <button type="button" onClick={() => composer.remove(7)}>remove</button>
      <span data-testid="pastes">
        {composer.pastes.map((p) => `${p.token}:${p.held ? `${p.held.lines}L${p.held.chars}C` : "unheld"}`).join(" ")}
      </span>
      <button type="button" onClick={() => void composer.expandPaste("[Pasted text #1]")}>expand</button>
      <button type="button" onClick={() => composer.removePaste("[Pasted text #1]")}>unpaste</button>
      <span data-testid="commands">
        {composer.commands.map((c) => `${c.selected ? ">" : ""}${c.name}`).join(" ")}
      </span>
      <button type="button" onClick={() => composer.chooseCommand("/rename")}>choose</button>
      <button
        type="button"
        // Two images of different sizes, which is how the test tells them apart in order.
        onClick={() => void composer.drop([new Blob(["1"]), new Blob(["22"])])}
      >
        drop
      </button>
      <button type="button" onClick={() => void composer.submit()}>send</button>
    </div>
  );
}

/**
 * One keystroke's worth of typing into the field.
 *
 * `fireEvent.change` rather than a hand-dispatched input event: React tracks a controlled input's
 * value itself, and assigning to `.value` updates that tracker, so the change it is meant to
 * announce is the one React then decides did not happen.
 */
export async function type(value: string, which = 0) {
  await act(async () => {
    fireEvent.change(screen.getAllByLabelText("composer")[which]!, { target: { value } });
  });
}

/** Lets every pending promise settle, and any timer shorter than `ms` fire. */
export async function settle(ms = 0) {
  await act(async () => {
    if (ms > 0) vi.advanceTimersByTime(ms);
    await vi.advanceTimersByTimeAsync(0);
  });
}

/**
 * Clicks a button and lets the chain of awaits behind it finish.
 *
 * More than one flush because a drop is a sequence of round trips rather than one: the draft,
 * then each image, each of which reads its own bytes. A single flush leaves it half done.
 */
export async function press(label: string) {
  await act(async () => {
    screen.getByText(label).click();
    for (let flush = 0; flush < 8; flush += 1) await vi.advanceTimersByTimeAsync(0);
  });
}


export const draft = () => screen.getByTestId("draft").textContent;
