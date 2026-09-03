/**
 * Minimal pub/sub state container — no VDOM, no reconciliation. Just enough
 * for a couple of list-driven HUD panels (inventory, later debug toggles) to
 * subscribe and re-render themselves when state changes, instead of every
 * mutation site having to know which DOM nodes depend on it.
 *
 * Deliberately tiny for Phase 3 — the full HUD architecture (lit-html panels,
 * theme.css) is a later phase; this is just the state-plumbing piece pulled
 * out early because the inventory panel already wants it.
 */
export type Unsubscribe = () => void;
export type Listener<T> = (state: T) => void;

export class Store<T> {
  private readonly listeners = new Set<Listener<T>>();

  constructor(private state: T) {}

  get(): T {
    return this.state;
  }

  set(next: T | ((prev: T) => T)): void {
    this.state = typeof next === "function" ? (next as (prev: T) => T)(this.state) : next;
    for (const listener of this.listeners) listener(this.state);
  }

  /** Returns an unsubscribe function. Does NOT call `listener` immediately
   * with the current state — callers that need an initial render should read
   * `get()` once themselves before subscribing. */
  subscribe(listener: Listener<T>): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
