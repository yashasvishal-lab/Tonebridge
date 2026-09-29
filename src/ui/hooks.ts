/**
 * Two hooks total. `useEngine` provides the singleton, `useApp` subscribes a component
 * to one slice of the model. The store only notifies when a shallow comparison of the
 * selected value changes, so the 10 Hz telemetry loop never re-renders a transcript.
 */
import { useContext, createContext, useRef, useSyncExternalStore } from 'react';
import type { AppModel, Engine } from '../link/engine.ts';

export const EngineContext = createContext<Engine | null>(null);

export function useEngine(): Engine {
  const e = useContext(EngineContext);
  if (e) return e;
  const g = globalThis as unknown as { __tonebridge?: Engine };
  if (g.__tonebridge) return g.__tonebridge;
  throw new Error('EngineContext is missing');
}

export function useApp<T>(select: (m: AppModel) => T): T {
  const engine = useEngine();
  const sel = useRef(select);
  sel.current = select;
  const cache = useRef<{ v: T; m: AppModel } | null>(null);
  const get = () => {
    const m = engine.store.get();
    if (!cache.current || cache.current.m !== m) cache.current = { v: sel.current(m), m };
    return cache.current.v;
  };
  return useSyncExternalStore(engine.store.subscribe, get, get);
}

export function clock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1048576).toFixed(2)} MB`;
}

export function db(v: number, unit = 'dB'): string {
  if (!Number.isFinite(v) || v <= -110) return `—${unit ? ' ' + unit : ''}`;
  return `${v.toFixed(1)} ${unit}`;
}

export function dur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}
