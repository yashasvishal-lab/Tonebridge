/**
 * Local persistence, with two rules: passphrases and key material are never written to
 * disk, and message contents are only kept if the user turns transcript saving on.
 * If storage is unavailable (private mode, blocked cookies) everything degrades to
 * memory instead of throwing.
 */

const KEY = 'tonebridge/settings/v1';
const TX = 'tonebridge/transcripts/v1';

export interface Persisted {
  profileId?: string;
  fecId?: string;
  node?: number;
  name?: string;
  txGain?: number;
  capture?: string;
  channelPreset?: string;
  snrDb?: number;
  autoAck?: boolean;
  beacon?: boolean;
  saveTranscripts?: boolean;
  tones?: string;
  symMs?: number;
  muted?: boolean;
}

function safeGet(store: Storage | null, key: string): string | null {
  if (!store) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(store: Storage | null, key: string, value: string): boolean {
  if (!store) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

const local: Storage | null = typeof localStorage !== 'undefined' ? localStorage : null;
const session: Storage | null = typeof sessionStorage !== 'undefined' ? sessionStorage : null;

export function loadSettings(): Persisted {
  const raw = safeGet(local, KEY) ?? safeGet(session, KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Persisted;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function saveSettings(patch: Persisted): void {
  const merged = { ...loadSettings(), ...patch };
  if (!safeSet(local, KEY, JSON.stringify(merged))) safeSet(session, KEY, JSON.stringify(merged));
}

export interface StoredTranscript {
  t: number;
  dir: 'rx' | 'tx';
  from?: number;
  to?: number;
  text?: string;
  kind?: string;
  secure?: boolean;
}

export function loadTranscripts(): StoredTranscript[] {
  const raw = safeGet(local, TX);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredTranscript[]) : [];
  } catch {
    return [];
  }
}

export function saveTranscripts(items: StoredTranscript[]): void {
  if (!safeSet(local, TX, JSON.stringify(items.slice(-200)))) return;
}

export function clearTranscripts(): void {
  try {
    local?.removeItem(TX);
    session?.removeItem(TX);
  } catch {
    /* nothing to do */
  }
}

export function storageAvailable(): boolean {
  return local !== null || session !== null;
}
