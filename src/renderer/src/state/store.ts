/**
 * store.ts: a ~40-line external store, read through `useSyncExternalStore`.
 *
 * Why not one `useState` in `App`: log lines arrive in batches up to 25 times a second during an
 * upgrade. If they lived in App's state, every batch would re-render the sidebar, the stat tiles and
 * all 39 table rows. Separate stores mean a log batch re-renders the terminal and nothing else.
 */

import { useSyncExternalStore } from 'react';

export class Store<T> {
  private listeners = new Set<() => void>();

  constructor(private state: T) {}

  readonly get = (): T => this.state;

  readonly set = (next: T | ((prev: T) => T)): void => {
    const value = typeof next === 'function' ? (next as (prev: T) => T)(this.state) : next;
    if (Object.is(value, this.state)) return;
    this.state = value;
    for (const listener of this.listeners) listener();
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/**
 * Subscribe to a derived slice, so a component only re-renders when its own slice changes.
 *
 * `selector` must return a stable value for unchanged input, a primitive, or a memoised object.
 * Returning a fresh object literal every call would re-render on every store notification.
 */
export function useSelector<T, S>(store: Store<T>, selector: (state: T) => S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
}
