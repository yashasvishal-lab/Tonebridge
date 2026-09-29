import { describe, expect, it } from 'vitest';
import { LinkCrypto } from '../src/link/crypto.ts';
import { packCtrl, unpack, KIND, CTRL } from '../src/link/messages.ts';
import type { CtrlEnvelope } from '../src/link/messages.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const asCtrl = (wire: Uint8Array): CtrlEnvelope => unpack(wire) as CtrlEnvelope;
const aad = (n: number): Uint8Array => Uint8Array.from({ length: 12 }, (_, i) => (i * 31 + n) & 0xff);

describe('link crypto', () => {
  it('starts open and adds no secrecy, only two framing bytes', async () => {
    const c = new LinkCrypto();
    expect(c.ready).toBe(false);
    expect(c.secure).toBe(false);
    expect(c.overhead).toBe(2);
    const sealed = await c.seal(enc('plain'), aad(1));
    // An open channel is still framed, so the receiver knows which cipher to expect.
    expect(sealed[0]).toBe(0);
    expect(dec(sealed.subarray(2))).toBe('plain');
    expect(await c.open(sealed, aad(1), 4)).toEqual(enc('plain'));
  });

  it('derives the same key from the same passphrase on two devices', async () => {
    const a = new LinkCrypto();
    const b = new LinkCrypto();
    await a.setPassphrase('four honest words');
    await b.setPassphrase('four honest words');
    expect(a.overhead).toBe(30);
    expect(a.ready).toBe(true);
    // PSK mode seals without a human confirmation step, and says so.
    expect(a.secure).toBe(true);
    const msg = enc('route 66, mile 12');
    const wire = await a.seal(msg, aad(9));
    expect(wire.length).toBe(msg.length + 30);
    expect(await b.open(wire, aad(9), 3)).toEqual(msg);
    expect(await b.fingerprint()).toBe(await a.fingerprint());
  });

  it('drops frames from a different passphrase, and refuses plaintext', async () => {
    const a = new LinkCrypto();
    const b = new LinkCrypto();
    await a.setPassphrase('correct horse battery staple');
    await b.setPassphrase('correct horse battery stapled');
    const wire = await a.seal(enc('secret'), aad(2));
    expect(await b.open(wire, aad(2), 5)).toBeNull();
    const events: string[] = [];
    const c = new LinkCrypto((e) => events.push(e.message));
    await c.setPassphrase('a long enough phrase');
    const forged = new Uint8Array(2 + 6);
    forged.set(enc('secret'), 2);
    expect(await c.open(forged, aad(3), 5)).toBeNull();
    expect(events.join(' ')).toMatch(/unencrypted/i);
  });

  it('will not accept a passphrase that is too short to matter', async () => {
    const c = new LinkCrypto();
    await expect(c.setPassphrase('short')).rejects.toThrow(/8 characters/);
    expect(c.ready).toBe(false);
  });

  it('binds the ciphertext to the frame header', async () => {
    const a = new LinkCrypto();
    await a.setPassphrase('the wire is the room');
    const wire = await a.seal(enc('payload'), aad(7));
    expect(await a.open(wire, aad(7), 1)).toEqual(enc('payload'));
    // Any change to the header - a different target, msg id or chunk index - and the
    // frame cannot be replayed into another slot of the transfer.
    expect(await a.open(wire, aad(8), 1)).toBeNull();
    const tampered = new Uint8Array(wire);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! + 1) & 0xff;
    expect(await a.open(tampered, aad(7), 1)).toBeNull();
  });

  it('counts a replayed frame instead of delivering it twice', async () => {
    const a = new LinkCrypto();
    const b = new LinkCrypto();
    await a.setPassphrase('shared secret phrase');
    await b.setPassphrase('shared secret phrase');
    const wire = await a.seal(enc('one time only'), aad(4));
    expect(await b.open(wire, aad(4), 11)).toEqual(enc('one time only'));
    expect(await b.open(wire, aad(4), 11)).toBeNull();
    expect(b.replaysDropped).toBe(1);
    // A different sender does not inherit that sender's replay window.
    expect(await b.open(wire, aad(4), 12)).toEqual(enc('one time only'));
  });

  it('never lets the counter go backwards within a key', async () => {
    const a = new LinkCrypto();
    await a.setPassphrase('ordering matters here');
    const w1 = await a.seal(enc('first'), aad(1));
    const w2 = await a.seal(enc('second'), aad(1));
    expect(w1.subarray(2, 14)).not.toEqual(w2.subarray(2, 14));
    // the IV embeds an 8-byte big-endian counter that increased
    const c1 = w1.subarray(2, 14);
    const c2 = w2.subarray(2, 14);
    expect(c1.subarray(4)).not.toEqual(c2.subarray(4));
  });

  it('burns key material on demand', async () => {
    const c = new LinkCrypto();
    await c.setPassphrase('erase me after use');
    expect(c.ready).toBe(true);
    c.burn();
    expect(c.ready).toBe(false);
    expect(c.secure).toBe(false);
    expect(c.keyObject).toBeNull();
    expect(c.overhead).toBe(2);
    expect(c.mode).toBe('open');
  });

  it('pairs two devices and confirms the short authentication string', async () => {
    const { a, b } = await LinkCrypto.pairTwice();
    expect(a.mode).toBe('pair');
    expect(b.mode).toBe('pair');
    expect(a.sas).toBeTruthy();
    expect(a.sas).toBe(b.sas);
    expect(/^\d{4} \d{4}$/.test(a.sas ?? '')).toBe(true);
    expect(a.secure).toBe(true);
    expect(b.secure).toBe(true);
    expect(a.pairState).toBe('confirmed');
    expect(a.fingerprint()).toBeTruthy();
    // keys are non-extractable by construction
    expect((await a.keyObject)?.type).toBe('secret');
    expect((await a.keyObject)?.extractable).toBe(false);
  });

  it('refuses a reveal that never followed its own commitment', async () => {
    const a = new LinkCrypto();
    const victim = new LinkCrypto();
    await victim.startPairing(false);
    const commitA = await a.startPairing(true);
    const challenge = await victim.handleCtrl(asCtrl(commitA!));
    expect(victim.pairState).toBe('challenged');
    // An on-path attacker who never answered with a commitment of its own cannot
    // install a key: a reveal is only meaningful to a device that is awaiting one.
    const forged = packCtrl(CTRL.PAIR_REVEAL, new Uint8Array(65 + 16));
    const reply = await a.handleCtrl(asCtrl(forged));
    expect(reply).toBeNull();
    expect(a.ready).toBe(false);
    expect(a.keyObject).toBeNull();
    // A is still waiting for its own commitment to come back, unharmed.
    expect(a.pairState).toBe('commitSent');
    expect(a.sas).toBeNull();
    // Out-of-order steps on the responder side are ignored too.
    expect(await victim.handleCtrl(asCtrl(commitA!))).toBeNull();
    expect(await victim.handleCtrl(asCtrl(challenge!))).toBeNull();
  });

  it('keeps the control channel as framing the rest of the messages share', async () => {
    const packed = packCtrl(CTRL.HELLO, enc('Bridge'));
    expect(packed[0]).toBe(KIND.CTRL);
    expect(packed[1]).toBe(CTRL.HELLO);
    const env = unpack(packed);
    expect(env).toMatchObject({ kind: KIND.CTRL, sub: CTRL.HELLO });
    // A commitment is exactly a 32-byte hash, nothing more: no key material travels.
    const a = new LinkCrypto();
    const commit = await a.startPairing(true);
    const ce = asCtrl(commit!);
    expect(ce.sub).toBe(CTRL.PAIR_COMMIT);
    expect(ce.data.length).toBe(32);
    expect(a.pairState).toBe('commitSent');
  });

  it('announces a pairing abort in a message a human can act on', async () => {
    const seen: string[] = [];
    const a = new LinkCrypto((e) => seen.push(e.message));
    await a.setPassphrase('events are user visible');
    const b = new LinkCrypto();
    await b.setPassphrase('something else entirely');
    const wire = await b.seal(enc('wrong key'), aad(1));
    expect(await a.open(wire, aad(1), 2)).toBeNull();
    expect(seen.join(' ')).toMatch(/node 2/);
  });
});
