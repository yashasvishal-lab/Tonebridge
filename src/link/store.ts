/**
 * A 60-line observable store. React's `useSyncExternalStore` does the rest, so there
 * is no state library to audit and no re-render storm: components subscribe to one
 * derived value and only wake up when that value actually changed.
 */

export type Listener = () => void;

export class Store<T extends object> {
  private snapshot: T;
  private listeners = new Set<Listener>();
  private depth = 0;

  constructor(initial: T) {
    this.snapshot = initial;
  }

  get = (): T => this.snapshot;

  set(patch: Partial<T> | ((prev: T) => Partial<T>)): void {
    const next = typeof patch === 'function' ? patch(this.snapshot) : patch;
    let changed = false;
    for (const k of Object.keys(next) as (keyof T)[]) {
      if (this.snapshot[k] !== next[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.snapshot = { ...this.snapshot, ...next };
    if (this.depth > 0) return;
    this.depth++;
    try {
      for (const l of this.listeners) l();
    } finally {
      this.depth--;
    }
  }

  /** Batch several updates into one notification. */
  batch(fn: (set: (p: Partial<T>) => void) => void): void {
    this.depth++;
    try {
      fn((p) => {
        this.snapshot = { ...this.snapshot, ...p };
      });
    } finally {
      this.depth--;
    }
    for (const l of this.listeners) l();
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
}

/** Shallow-equality selector hook helper. */
export function pick<K extends string, V>(obj: Record<K, V>, keys: K[]): Pick<Record<K, V>, K> {
  const out = {} as Record<K, V>;
  for (const k of keys) out[k] = obj[k];
  return out;
}
