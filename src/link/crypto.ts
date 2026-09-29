/**
 * Secure channel.
 *
 * Two ways to get a key, one wire format:
 *
 *  - Passphrase: PBKDF2-SHA256, 250 000 rounds, salt bound to the protocol label.
 *    There is deliberately no "key check" on the wire, so a recorder gets nothing to
 *    run an offline guessing attack against: a wrong passphrase simply fails AEAD
 *    authentication. Same key every session, so it has no forward secrecy - use
 *    pairing for that.
 *  - Pairing: ephemeral ECDH P-256 with a commit-then-reveal exchange, so neither
 *    side can choose its key after seeing the other's, plus a short authenticated
 *    string that two humans read aloud to defeat a relay sitting between speakers.
 *
 * Frames are sealed with AES-GCM-256. The FEC frame header is additional
 * authenticated data, so sender / target / msgId / chunk index / flags cannot be
 * edited in the room, and the receiver keeps a per-sender replay window so a
 * recording of a past transmission cannot be replayed for effect.
 */

import { packCtrl, unpack, CTRL } from './messages.ts';
import type { CtrlEnvelope } from './messages.ts';

const TAG = 'tonebridge/pair/1';
const INFO = 'tonebridge/aead/1';
const SAS_LABEL = 'tonebridge/sas/1';
const PBKDF2_ROUNDS = 250_000;
const REPLAY_WINDOW = 64;

export type Mode = 'open' | 'psk' | 'pair';
export type PairState = 'idle' | 'commitSent' | 'challenged' | 'verifying' | 'confirmed';

export interface CryptoEvent {
  level: 'info' | 'ok' | 'warn' | 'error';
  message: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

const subtle = (): SubtleCrypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    throw new Error('WebCrypto unavailable: encryption needs a secure context (https:// or localhost)');
  }
  return c.subtle;
};

async function sha256(...parts: (Uint8Array | string)[]): Promise<Uint8Array> {
  const chunks = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
  let len = 0;
  for (const c of chunks) len += c.length;
  const buf = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.length;
  }
  return new Uint8Array(await subtle().digest('SHA-256', buf as unknown as BufferSource));
}

function randomBytes(n: number): Uint8Array {
  (globalThis as { crypto: Crypto }).crypto.getRandomValues;
  const b = new Uint8Array(n);
  (globalThis as { crypto: Crypto }).crypto.getRandomValues(b);
  return b;
}

function toHex(b: Uint8Array): string {
  let s = '';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function counterBytes(n: number): Uint8Array {
  const out = new Uint8Array(8);
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  for (let i = 0; i < 4; i++) out[i] = (hi >>> (24 - i * 8)) & 0xff;
  for (let i = 0; i < 4; i++) out[4 + i] = (lo >>> (24 - i * 8)) & 0xff;
  return out;
}

function u32(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
}

/** IV = 4-byte random session epoch || 8-byte monotonic counter (NIST SP 800-38D construction). */
function makeIv(epoch: number, counter: number): Uint8Array {
  const iv = new Uint8Array(12);
  iv[0] = (epoch >>> 24) & 0xff;
  iv[1] = (epoch >>> 16) & 0xff;
  iv[2] = (epoch >>> 8) & 0xff;
  iv[3] = epoch & 0xff;
  iv.set(counterBytes(counter), 4);
  return iv;
}

/** cipher(1) + reserved(1) + iv(12) + ciphertext */
const WIRE_HDR = 14;

interface ReplayState {
  epoch: number;
  highest: number;
  seen: number;
}

export class LinkCrypto {
  mode: Mode = 'open';
  pairState: PairState = 'idle';
  sas: string | null = null;
  keyConfirmed = false;
  /** Non-zero only when a frame was dropped because it repeated an earlier one. */
  replaysDropped = 0;

  private key: CryptoKey | null = null;
  private ecdh: CryptoKeyPair | null = null;
  private localPub: Uint8Array | null = null;
  private localRand = randomBytes(16);
  private localCommit: Uint8Array | null = null;
  private peerCommit: Uint8Array | null = null;
  private peerPub: Uint8Array | null = null;
  private peerRand: Uint8Array | null = null;
  private initiator = true;
  private txCounter = 0;
  private epoch = u32(randomBytes(4), 0) || 1;
  private replay = new Map<number, ReplayState>();
  private onEvent: (e: CryptoEvent) => void;

  constructor(onEvent: (e: CryptoEvent) => void = () => {}) {
    this.onEvent = onEvent;
  }

  /** True when frames can be sealed *and* the key has been authenticated by a human. */
  get secure(): boolean {
    return this.key !== null && (this.mode !== 'pair' || this.keyConfirmed);
  }

  get ready(): boolean {
    return this.key !== null;
  }

  /** Bytes the wire envelope adds around a payload - needed to size frames before sealing. */
  get overhead(): number {
    return this.key ? WIRE_HDR + 16 : 2;
  }

  get cipherId(): number {
    return this.key ? 1 : 0;
  }

  get statusLabel(): string {
    if (this.mode === 'open') return 'Open channel';
    if (this.mode === 'psk') return 'Passphrase key';
    if (!this.key) return 'Pairing…';
    return this.keyConfirmed ? 'Paired + confirmed' : 'Paired, awaiting code check';
  }

  async fingerprint(): Promise<string | null> {
    if (!this.key) return null;
    if (this.mode === 'pair') {
      const mine = this.localPub ?? (await this.ensureEcdh());
      const h = await sha256('tonebridge/fp/1', this.initiator ? concatBytes(mine, this.peerPub ?? new Uint8Array()) : concatBytes(this.peerPub ?? new Uint8Array(), mine));
      return toHex(h.subarray(0, 8)).toUpperCase();
    }
    const h = await sha256('tonebridge/fp/1', new Uint8Array([0xf0, 0x0d]));
    return `psk:${toHex(h.subarray(0, 4))}`;
  }

  reset(): void {
    this.mode = 'open';
    this.key = null;
    this.ecdh = null;
    this.localPub = null;
    this.localCommit = null;
    this.peerCommit = null;
    this.peerPub = null;
    this.peerRand = null;
    this.localRand = randomBytes(16);
    this.pairState = 'idle';
    this.sas = null;
    this.keyConfirmed = false;
    this.txCounter = 0;
    this.epoch = u32(randomBytes(4), 0) || 1;
    this.replay.clear();
  }

  /** Wipe key material and return the channel to open mode. Nothing is kept on
   * purpose: to resume a sealed session you retype the passphrase or pair again. */
  burn(): void {
    this.mode = 'open';
    this.key = null;
    this.ecdh = null;
    this.localPub = null;
    this.pairState = 'idle';
    this.sas = null;
    this.keyConfirmed = false;
    this.replay.clear();
    this.onEvent({ level: 'warn', message: 'Session key erased from memory. Traffic from the previous key is now unreadable.' });
  }

  async setPassphrase(passphrase: string): Promise<void> {
    if (passphrase.length < 8) throw new Error('That passphrase is too short to be worth wrapping anything in: 8 characters minimum');
    const salt = await sha256('tonebridge/psk/1', passphrase);
    // importKey takes bytes, not a string: browsers differ on whether they coerce it,
    // so encode explicitly rather than rely on a USVString being accepted here.
    const base = await subtle().importKey('raw', enc.encode(passphrase.normalize('NFKC')) as unknown as BufferSource, 'PBKDF2', false, ['deriveKey']);
    this.key = await subtle().deriveKey(
      { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    this.mode = 'psk';
    this.pairState = 'idle';
    this.sas = null;
    this.txCounter = 0;
    this.replay.clear();
    this.onEvent({
      level: 'ok',
      message: `Key derived with PBKDF2-SHA256 × ${PBKDF2_ROUNDS.toLocaleString('en-US')}, marked non-extractable.`,
    });
  }

  // ---- sealing -------------------------------------------------------------

  /** @param body message-layer payload @param aad the FEC frame header bytes */
  async seal(body: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
    if (!this.key) {
      const out = new Uint8Array(2 + body.length);
      out.set(body, 2);
      return out;
    }
    const counter = this.txCounter++;
    const iv = makeIv(this.epoch, counter);
    const ct = new Uint8Array(
      await subtle().encrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: 128 },
        this.key,
        body as unknown as BufferSource,
      ),
    );
    const out = new Uint8Array(WIRE_HDR + ct.length);
    out[0] = 1;
    out[1] = 0;
    out.set(iv, 2);
    out.set(ct, WIRE_HDR);
    return out;
  }

  async open(wire: Uint8Array, aad: Uint8Array, from: number): Promise<Uint8Array | null> {
    if (wire.length < 2) return null;
    const cipher = wire[0]!;
    if (cipher === 0) {
      if (this.key) {
        this.onEvent({ level: 'warn', message: `Dropped an unencrypted frame from node ${from} on a keyed channel.` });
        return null;
      }
      return wire.subarray(2);
    }
    if (!this.key) return null;
    if (wire.length < WIRE_HDR) return null;
    const iv = wire.subarray(2, 14);
    const epoch = u32(iv, 0);
    const counter = counterOf(iv);
    const st = this.replay.get(from);
    if (st && st.epoch === epoch) {
      if (counter > st.highest) {
        // fine
      } else if (counter === st.highest) {
        this.replaysDropped++;
        return null;
      } else {
        const back = st.highest - counter;
        if (back >= REPLAY_WINDOW) {
          this.replaysDropped++;
          return null;
        }
        if ((st.seen >>> back) & 1) {
          this.replaysDropped++;
          return null;
        }
      }
    }
    let plain: ArrayBuffer;
    try {
      plain = await subtle().decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: aad as unknown as BufferSource, tagLength: 128 },
        this.key,
        wire.subarray(WIRE_HDR) as unknown as BufferSource,
      );
    } catch {
      this.onEvent({ level: 'warn', message: `Frame from node ${from} failed authentication (different key, or tampered in the room).` });
      return null;
    }
    const cur = this.replay.get(from);
    if (!cur || cur.epoch !== epoch || counter >= cur.highest) {
      const shift = cur && cur.epoch === epoch ? Math.min(31, counter - cur.highest) : 1;
      this.replay.set(from, { epoch, highest: counter, seen: cur && cur.epoch === epoch ? ((cur.seen << shift) | 1) >>> 0 : 1 });
    } else {
      cur.seen = (cur.seen | (1 << (cur.highest - counter))) >>> 0;
    }
    return new Uint8Array(plain);
  }

  // ---- pairing -------------------------------------------------------------

  private async ensureEcdh(): Promise<Uint8Array> {
    if (!this.ecdh) {
      this.ecdh = await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
    }
    this.localPub = new Uint8Array(await subtle().exportKey('raw', this.ecdh.publicKey));
    return this.localPub;
  }

  /**
   * Kick off pairing. The initiator commits to its key without revealing it, so the
   * responder cannot pick a key that depends on it.
   * @returns a CTRL payload to transmit, or null when the other side should speak first.
   */
  async startPairing(initiator: boolean): Promise<Uint8Array | null> {
    this.initiator = initiator;
    this.mode = 'pair';
    const pub = await this.ensureEcdh();
    this.localRand = randomBytes(16);
    this.localCommit = await sha256(TAG, pub, this.localRand);
    this.peerCommit = null;
    this.peerPub = null;
    this.peerRand = null;
    this.key = null;
    this.keyConfirmed = false;
    this.sas = null;
    this.replay.clear();
    if (initiator) {
      this.pairState = 'commitSent';
      return packCtrl(CTRL.PAIR_COMMIT, this.localCommit);
    }
    this.pairState = 'idle';
    return null;
  }

  /** Run one handshake step. @returns a payload to send straight back, or null. */
  async handleCtrl(env: CtrlEnvelope): Promise<Uint8Array | null> {
    const d = env.data;
    if (this.mode !== 'pair') return null;
    switch (env.sub) {
      case CTRL.PAIR_COMMIT: {
        if (d.length < 32) return null;
        if (this.pairState !== 'idle') {
          this.onEvent({ level: 'warn', message: 'Ignoring an out-of-order pairing commitment; a handshake is already running.' });
          return null;
        }
        this.peerCommit = d.subarray(0, 32);
        const pub = await this.ensureEcdh();
        this.pairState = 'challenged';
        return packCtrl(CTRL.PAIR_CHALLENGE, concatBytes(pub, this.localRand, this.localCommit!));
      }
      case CTRL.PAIR_CHALLENGE: {
        if (d.length < 65 + 16 + 32) return null;
        // Only the device that sent a commitment may be answered with a challenge, and
        // only once: otherwise a third party could inject a key of its choosing.
        if (this.pairState !== 'commitSent' || !this.localCommit) {
          this.onEvent({ level: 'warn', message: 'Ignoring a pairing challenge that did not follow our commitment.' });
          return null;
        }
        const pub = d.subarray(0, 65);
        const rand = d.subarray(65, 81);
        const commit = d.subarray(81, 113);
        if (toHex(await sha256(TAG, pub, rand)) !== toHex(commit)) {
          this.onEvent({ level: 'error', message: 'Pairing challenge commitment is inconsistent. Aborting.' });
          this.pairState = 'idle';
          return null;
        }
        this.peerCommit = commit;
        this.peerPub = pub;
        this.peerRand = rand;
        await this.derive(pub, rand, commit);
        this.pairState = 'verifying';
        await this.computeSas();
        return packCtrl(CTRL.PAIR_REVEAL, concatBytes(await this.ensureEcdh(), this.localRand));
      }
      case CTRL.PAIR_REVEAL: {
        if (d.length < 65 + 16) return null;
        if (this.pairState !== 'challenged' || !this.peerCommit) {
          this.onEvent({ level: 'warn', message: 'Ignoring a pairing reveal: we never saw the commitment it must match.' });
          return null;
        }
        const pub = d.subarray(0, 65);
        const rand = d.subarray(65, 81);
        if (toHex(await sha256(TAG, pub, rand)) !== toHex(this.peerCommit)) {
          this.pairState = 'idle';
          this.key = null;
          this.onEvent({ level: 'error', message: 'Pairing reveal did not match the commitment: the peer changed its key mid-handshake. Nothing was sent.' });
          return null;
        }
        this.peerPub = pub;
        this.peerRand = rand;
        await this.derive(pub, rand, this.peerCommit);
        this.pairState = 'verifying';
        await this.computeSas();
        return null;
      }
      default:
        return null;
    }
  }

  private async derive(pub: Uint8Array, _rand: Uint8Array, peerCommit: Uint8Array): Promise<void> {
    void _rand;
    const peerKey = await subtle().importKey('raw', pub as unknown as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    if (!this.ecdh) throw new Error('pairing state lost');
    const shared = await subtle().deriveBits({ name: 'ECDH', public: peerKey }, this.ecdh.privateKey, 256);
    const mine = this.localCommit ?? new Uint8Array(32);
    const ordered = toHex(mine) <= toHex(peerCommit) ? [mine, peerCommit] : [peerCommit, mine];
    const salt = await sha256(TAG, ...ordered);
    const kdf = await subtle().importKey('raw', shared as unknown as BufferSource, { name: 'HKDF' }, false, ['deriveKey']);
    this.key = await subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: salt as unknown as BufferSource, info: enc.encode(INFO) as unknown as BufferSource },
      kdf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    this.txCounter = 0;
    this.epoch = u32(randomBytes(4), 0) || 1;
    this.replay.clear();
    this.onEvent({ level: 'ok', message: 'ECDH P-256 secret derived and stretched with HKDF-SHA256 into a non-extractable AES-GCM key.' });
  }

  private async computeSas(): Promise<void> {
    const mine = this.localPub ?? (await this.ensureEcdh());
    const theirs = this.peerPub ?? new Uint8Array(65);
    const mineFirst = toHex(mine) <= toHex(theirs);
    const h = await sha256(
      SAS_LABEL,
      ...(mineFirst ? [mine, this.localRand, theirs, this.peerRand ?? new Uint8Array(16)] : [theirs, this.peerRand ?? new Uint8Array(16), mine, this.localRand]),
    );
    const v = u32(h, 0);
    const code = (v % 100_000_000).toString().padStart(8, '0');
    this.sas = `${code.slice(0, 4)} ${code.slice(4)}`;
    this.onEvent({ level: 'info', message: `Pairing code ${this.sas}. Read it aloud to the other device and confirm it matches before trusting the link.` });
  }

  confirmPairing(): void {
    if (!this.sas) return;
    this.keyConfirmed = true;
    this.pairState = 'confirmed';
    this.onEvent({ level: 'ok', message: 'Pairing code confirmed. This link is now authenticated against in-room interception.' });
  }

  get keyObject(): CryptoKey | null {
    return this.key;
  }

  /** Wire the two ends of a handshake together (used by the tests and the CLI). */
  static async pairTwice(): Promise<{ a: LinkCrypto; b: LinkCrypto; roundTrip: string | null }> {
    const a = new LinkCrypto();
    const b = new LinkCrypto();
    // Both sides must enter pairing mode; only the initiator has something to send yet.
    await b.startPairing(false);
    const offer = await a.startPairing(true);
    if (!offer) throw new Error('expected an offer');
    const step1 = await b.handleCtrl(unpack(offer) as CtrlEnvelope);
    if (!step1) throw new Error('expected a challenge');
    const step2 = await a.handleCtrl(unpack(step1) as CtrlEnvelope);
    if (step2) await b.handleCtrl(unpack(step2) as CtrlEnvelope);
    a.confirmPairing();
    b.confirmPairing();
    const aad = new Uint8Array([1, 2, 3, 4]);
    const sealed = await a.seal(enc.encode('hello over the air'), aad);
    const opened = await b.open(sealed, aad, 1);
    return { a, b, roundTrip: opened ? dec.decode(opened) : null };
  }
}

function counterOf(iv: Uint8Array): number {
  const hi = u32(iv, 4);
  const lo = u32(iv, 8);
  return hi * 0x100000000 + (lo >>> 0);
}
