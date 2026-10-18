// State that belongs to one data source rather than to a component, read by every component that
// shows it.
//
// Some widgets are drawn several times at once -- the sidebar is mounted as the pinned rail, the
// hover preview and the phone drawer -- so their data has to be one answer across those mounts and
// outlive any one of them. Lifting it into `App` did that and made it part of `App`: a save that
// broke it, or one that changed the hooks inside it, cost the whole tab (AGENTS.md, "Live data a
// widget shows lives in a store"). Here it is plain state outside React, and a widget subscribes
// from inside its own boundary.
//
// One entry per data source, in a `WeakMap` so a machine that goes away takes its entry with it.
// Readers are counted, so whatever an entry holds open -- a stream, a poll -- is closed after the
// last one leaves; the state stays, so the next reader shows what was known and then corrects.

import { useCallback, useSyncExternalStore } from "react";

export interface SourceStore<Source extends object, State> {
  get(source: Source): State;
  /** Replaces the entry's state and tells its readers. Fine to call with nobody reading. */
  set(source: Source, next: (current: State) => State): void;
  subscribe(source: Source, listener: () => void): () => void;
  /** Counts a reader in; the returned function counts it out. */
  retain(source: Source): () => void;
}

export function createSourceStore<Source extends object, State>({
  initial,
  opened,
  closed,
}: {
  initial: () => State;
  /** The first reader arrived. */
  opened?: (source: Source) => void;
  /** The last reader left: close what the entry holds open. */
  closed?: (source: Source) => void;
}): SourceStore<Source, State> {
  interface Entry {
    state: State;
    listeners: Set<() => void>;
    readers: number;
  }
  const entries = new WeakMap<Source, Entry>();

  function entryFor(source: Source): Entry {
    const existing = entries.get(source);
    if (existing) return existing;
    const made: Entry = { state: initial(), listeners: new Set(), readers: 0 };
    entries.set(source, made);
    return made;
  }

  return {
    get: (source) => entryFor(source).state,
    set(source, next) {
      const entry = entryFor(source);
      entry.state = next(entry.state);
      for (const listener of entry.listeners) listener();
    },
    subscribe(source, listener) {
      const entry = entryFor(source);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    retain(source) {
      const entry = entryFor(source);
      entry.readers += 1;
      if (entry.readers === 1) opened?.(source);
      return () => {
        entry.readers -= 1;
        if (entry.readers === 0) closed?.(source);
      };
    },
  };
}

/**
 * One data source's entry, re-rendering on every change, and counted as a reader while subscribed.
 *
 * Two hooks that never change, so editing a store's logic never changes the hooks of the component
 * reading it -- React's "Should have a queue" needs a changed hook list to happen. The reader is
 * counted in by the subscription itself, so what the entry holds open follows exactly the
 * subscriptions React keeps, with no effect of its own.
 */
export function useSourceStore<Source extends object, State>(
  store: SourceStore<Source, State>,
  source: Source,
): State {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unlisten = store.subscribe(source, onChange);
      const release = store.retain(source);
      return () => {
        unlisten();
        release();
      };
    },
    [store, source],
  );
  // The entry's own object, unchanged between reads, because `useSyncExternalStore` compares
  // snapshots by identity and a fresh one per render loops instead of re-rendering.
  const read = () => store.get(source);
  return useSyncExternalStore(subscribe, read, read);
}
