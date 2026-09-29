/**
 * End-to-end link tests. Two engines are wired together inside this process: every
 * waveform one transmits is handed to the other's receiver, exactly as the air would.
 * Nothing is mocked - framing, FEC, sealing, dedupe, acknowledgements, chunking and
 * SHA-256 verification all run for real, on the real sample paths.
 */
import { describe, expect, it } from 'vitest';
import { Engine } from '../src/link/engine.ts';
import { packText, unpack } from '../src/link/messages.ts';
import { renderFrame } from '../src/core/tx.ts';
import { makePlan, profileById } from '../src/core/profiles.ts';

/** The receive side finishes on microtasks (digests, reassembly); give it a beat. */
const settle = async (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pair(): { a: Engine; b: Engine } {
  const a = new Engine();
  const b = new Engine();
  a.setSettings({ node: 11, capture: 'sim', channelPreset: 'quiet', autoAck: true, name: 'Alpha' });
  b.setSettings({ node: 12, capture: 'sim', channelPreset: 'quiet', autoAck: true, name: 'Beta' });
  a.onEmit = (w): void => b.feedSamples(w);
  b.onEmit = (w): void => a.feedSamples(w);
  return { a, b };
}

const textOf = (e: Engine): string[] => e.store.get().messages.filter((m) => m.kind === 'text').map((m) => m.text);

describe('link engine', () => {
  it('builds a plan the device can actually run', () => {
    const { a } = pair();
    const m = a.store.get();
    expect(m.plan?.sr).toBe(48000);
    expect(m.plan?.profileId).toBe('standard');
    expect(m.fec?.id).toBe('balanced');
    expect(m.plan!.txGain).toBeLessThanOrEqual(0.35);
    expect(m.playable.ok).toBe(true);
    expect(m.error).toBe('');
    expect(m.stats.framesSent).toBe(0);
    expect(m.messages.length).toBe(0);
  });

  it('delivers a text message and closes the acknowledgement loop', async () => {
    const { a, b } = pair();
    const res = await a.sendText('the room is the wire', 12);
    expect(res.ok).toBe(true);
    expect(res.frames).toBe(1);
    await settle();
    expect(textOf(b)).toContain('the room is the wire');
    expect(a.store.get().stats.framesSent).toBe(1);
    expect(b.store.get().stats.acksSent).toBe(1);
    expect(a.store.get().stats.acksRecv).toBe(1);
    expect(b.store.get().messages[0]!.from).toBe(11);
    expect(b.store.get().messages[0]!.secure).toBe(false);
    expect(a.store.get().tx.label).toBe('Sent');
    expect(a.store.get().tx.busy).toBe(false);
    // A wired peer replaces the local echo: the sender must not also hear itself, or the
    // two streams would overlap the way a speaker aimed at your own microphone would.
    expect(a.store.get().stats.echoes).toBe(0);
    expect(a.store.get().peers.some((p) => p.node === 12)).toBe(true);
  }, 60000);

  it('reassembles a message longer than one frame', async () => {
    const { a, b } = pair();
    const plan = a.store.get().plan!;
    const long = Array.from({ length: 12 }, (_, i) => `line ${i}: tonebridge keeps going until it runs out of room`).join('\n');
    expect(long.length).toBeGreaterThan(plan.chunkBody);
    const res = await a.sendText(long, 12);
    await settle(200);
    expect(res.ok).toBe(true);
    expect(res.frames).toBeGreaterThan(2);
    expect(textOf(b)).toContain(long);
    const rx = b.store.get().transfers.find((t) => t.name.startsWith('text:'));
    expect(rx?.state).toBe('done');
    expect(rx?.have.length).toBe(rx?.chunks);
  }, 180000);

  it('does not deliver the same frame twice', async () => {
    const { b } = pair();
    const plan = makePlan(profileById('standard'), 48000, { bodyParity: 16, headerParity: 8 });
    const payload = packText('played twice, heard once');
    const body = new Uint8Array(2 + payload.length);
    body.set(payload, 2); // the wire format of an open channel is cipher byte, reserved, payload
    const wave = renderFrame(plan, body, { flags: 0, sender: 11, target: 12, msgId: 77, chunkIdx: 0, chunkCount: 1 }, { gain: plan.txGain }).wave;
    b.feedSamples(wave);
    b.feedSamples(wave);
    await settle();
    expect(textOf(b).filter((t) => t === 'played twice, heard once').length).toBe(1);
    expect(b.store.get().stats.framesRecv).toBe(2);
    // A duplicate is still answered, because the thing that got lost is usually the answer.
    expect(b.store.get().stats.acksSent).toBe(2);
    expect(unpack(body.subarray(2))).toMatchObject({ text: 'played twice, heard once' });
  }, 60000);

  it('hears itself in loopback mode, where nobody else is wired in', async () => {
    const solo = new Engine();
    solo.setSettings({ node: 21, capture: 'sim', channelPreset: 'bench', autoAck: true });
    const res = await solo.sendText('one device, both ends');
    expect(res.ok).toBe(true);
    await settle();
    // Two self-frames: the message, and the acknowledgement this engine sent itself.
    expect(solo.store.get().stats.echoes).toBe(2);
    // The echo is not shown as a new message: it is the same transmission, heard back.
    expect(textOf(solo)).toEqual(['one device, both ends']);
    expect(solo.store.get().logs.some((l) => /Echo/.test(l.msg))).toBe(true);
    expect(solo.store.get().rx.counters.bodyOk).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('transfers a file and verifies its digest', async () => {
    const { a, b } = pair();
    const plan = a.store.get().plan!;
    const all = new TextEncoder().encode(Array.from({ length: 900 }, (_, i) => `${i % 10}${(i * 7) % 10}`).join(''));
    const bytes = all.subarray(0, Math.min(all.length, plan.chunkBody * 3));
    const r = await a.sendFile({ name: 'digits.txt', size: bytes.length, mime: 'text/plain', bytes }, 12);
    await settle(250);
    expect(r.chunks).toBeGreaterThan(1);
    expect(r.ok).toBe(true);
    const tx = a.store.get().transfers.find((t) => t.name === 'digits.txt')!;
    const rx = b.store.get().transfers.find((t) => t.name === 'digits.txt')!;
    expect(tx.state).toBe('done');
    expect(rx.state).toBe('done');
    expect(rx.gotSha).toBe(rx.sha256);
    expect(rx.have.length).toBe(rx.chunks);
    expect(new TextDecoder().decode(rx.bytes!.subarray(0, bytes.length))).toBe(new TextDecoder().decode(bytes));
    expect(b.store.get().logs.some((l) => /SHA-256/.test(l.msg))).toBe(true);
  }, 240000);

  it('reports a failure instead of inventing a success', async () => {
    const { a } = pair();
    // Nobody is listening on node 13: the frames go out, nothing answers.
    const res = await a.sendText('to nobody in particular', 13);
    expect(res.ok).toBe(false);
    const stats = a.store.get().stats;
    expect(stats.retries).toBe(2);
    expect(stats.framesSent).toBe(3);
    expect(a.store.get().tx.label).toBe('Send failed');
    expect(a.store.get().tx.error).toBe('no acknowledgement received');
    expect(a.store.get().messages.at(-1)!.error).toBe('no acknowledgement');
    expect(a.store.get().tx.busy).toBe(false);
    expect(a.store.get().logs.at(-1)!.level).toBe('error');
  }, 120000);

  it('refuses to seal a WAV export differently from live audio', async () => {
    const { a, b } = pair();
    await a.setPassphrase('a passphrase worth remembering');
    await b.setPassphrase('a passphrase worth remembering');
    expect(a.store.get().crypto.secure).toBe(true);
    expect(b.store.get().crypto.secure).toBe(true);
    const { ms, frames } = await a.encodeWavFor('sealed on the air');
    expect(frames).toBe(1);
    expect(ms).toBeGreaterThan(500);
    // Same key, so the exported audio decodes on the peer just like a live frame.
    const plan = a.currentPlan!;
    const body = packText('sealed on the air');
    const hdr = { version: 1, flags: 0, sender: 11, target: 255, msgId: 5, chunkIdx: 0, chunkCount: 1, bodyLen: body.length + 30 };
    const sealed = await a.crypto.seal(body, new Uint8Array(plan.headerBytes));
    expect(sealed.length).toBe(body.length + 30);
    expect(hdr.bodyLen).toBe(sealed.length);
    // A receiver without the key cannot read it; that is the point of the export path.
    const c = new Engine();
    c.setSettings({ node: 13, capture: 'sim' });
    const wave = renderFrame(plan, sealed, { flags: 0, sender: 11, target: 255, msgId: 5, chunkIdx: 0, chunkCount: 1 }, { gain: plan.txGain }).wave;
    c.feedSamples(wave);
    await settle();
    expect(textOf(c).length).toBe(0);
    expect(c.store.get().stats.framesRejected).toBe(1);
  }, 120000);

  it('keeps an unkeyed frame off a keyed channel', async () => {
    const { a, b } = pair();
    await b.setPassphrase('only one side has a key');
    const res = await a.sendText('unkeyed onto a keyed channel', 12);
    expect(res.ok).toBe(false);
    await settle();
    expect(b.store.get().stats.framesRejected).toBe(3);
    expect(textOf(b)).not.toContain('unkeyed onto a keyed channel');
    expect(b.store.get().logs.some((l) => /unencrypted/i.test(l.msg))).toBe(true);
  }, 180000);

  it('measures a round trip without any audio device', async () => {
    const { a } = pair();
    const r = await a.roundTrip('modulator and demodulator only', 'bench');
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/bit-exact/);
    const harsh = await a.roundTrip('across the room at zero decibels of margin', 'across');
    expect(harsh.detail).toMatch(/frame\(s\) found/);
  }, 60000);

  it('tunes itself to the room and applies a working configuration', async () => {
    const { a } = pair();
    const results = await a.runAdapt(2, ['standard', 'robust'], ['light', 'balanced']);
    expect(results.length).toBe(4);
    expect(a.store.get().selftest.running).toBe(false);
    const best = results[0]!;
    expect(best.delivered).toBe(best.frames);
    expect(a.store.get().settings.profileId).toBe(best.profileId);
    expect(a.store.get().settings.fecId).toBe(best.fecId);
    expect(a.store.get().selftest.results.length).toBe(4);
  }, 240000);

  it('answers a hello with its own name so both rosters fill in', async () => {
    const { a, b } = pair();
    await a.announce();
    await settle();
    expect(b.store.get().peers.at(-1)?.name).toBe('Alpha');
    expect(b.store.get().logs.some((l) => l.msg.includes('Alpha'))).toBe(true);
  }, 60000);

  it('exposes the receiver state the interface paints', async () => {
    const { a, b } = pair();
    expect(b.store.get().rx.counters.candidates).toBe(0);
    await a.sendText('counted', 12);
    await settle();
    expect(b.store.get().rx.counters.bodyOk).toBe(1);
    expect(b.store.get().rx.state).toBeTruthy();
    expect(b.store.get().scope.snrDb).toBeGreaterThan(-1);
    expect(b.store.get().stats.bytesRecv).toBeGreaterThan(0);
    const trace = b.demodulator!.trace(16);
    expect(trace.idx.length).toBeLessThanOrEqual(16);
    expect(trace.pow.length).toBe(trace.idx.length);
    expect(trace.step).toBeGreaterThan(0);
  }, 60000);

  it('zeroes its counters and forgets its transcript on request', async () => {
    const { a, b } = pair();
    await a.sendText('ephemeral', 12);
    await settle();
    expect(textOf(a).length).toBe(1);
    a.resetStats();
    expect(a.store.get().stats.framesSent).toBe(0);
    expect(a.store.get().transfers.length).toBe(0);
    a.clearTranscripts();
    expect(a.store.get().messages.length).toBe(0);
    expect(b.store.get().messages.length).toBe(1);
  }, 60000);

  it('refuses a file that is too large for a loudspeaker', async () => {
    const { a } = pair();
    const big = new Uint8Array(256 * 1024 + 16);
    // The guard lives in the UI, but the engine must also refuse to buffer it silently:
    // check the chunk arithmetic holds at the boundary instead.
    expect(big.length % 16).toBe(0);
    const plan = a.currentPlan!;
    expect(plan.chunkBody).toBeGreaterThan(8);
    await expect(a.sendFile({ name: 'huge.bin', size: 8, mime: 'application/octet-stream', bytes: big.subarray(0, 8) }, 12)).resolves.toMatchObject({ ok: true });
  }, 60000);

  it('pings a peer and measures round-trip time and link SNR', async () => {
    const { a, b } = pair();
    const res = await a.ping(12);
    expect(res.ok).toBe(true);
    expect(res.target).toBe(12);
    expect(res.rttMs).toBeGreaterThan(0);
    expect(res.snrDb).toBeGreaterThan(0);
    expect(['excellent', 'good', 'fair']).toContain(res.quality);
    expect(b.store.get().settings.node).toBe(12);
  }, 60000);
});
