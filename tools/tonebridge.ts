/**
 * Tonebridge command line - the same core as the web app, driven from a shell.
 *
 *   npm run cli -- encode --text "meet at the gate" --out out.wav
 *   npm run cli -- decode out.wav
 *   npm run cli -- selftest --n 12
 *   npm run cli -- matrix --n 6      # every profile against every room model
 *
 * It exists because an acoustic modem you cannot verify offline is a modem you
 * cannot trust: encode, corrupt through the channel model, decode, compare.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { PROFILES, fecById, makePlan, profileById } from '../src/core/profiles.ts';
import { renderFrame } from '../src/core/tx.ts';
import { decodeRecording } from '../src/core/rx.ts';
import { encodeWav, decodeWav } from '../src/core/wav.ts';
import { applyChannel, mulberry32, presetById, CHANNEL_PRESETS } from '../src/core/channel.ts';
import { sweep } from '../src/core/adapt.ts';
import { packText, unpack, KIND } from '../src/link/messages.ts';
import { crc16 } from '../src/core/bit.ts';
import { FLAGS, HDR } from '../src/core/types.ts';

interface Args {
  _: string[];
  [k: string]: string | number | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = /^-?\d+(\.\d+)?$/.test(next) ? Number(next) : next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const str = (a: Args, k: string, d: string): string => (typeof a[k] === 'string' ? (a[k] as string) : d);
const num = (a: Args, k: string, d: number): number => (typeof a[k] === 'number' ? (a[k] as number) : d);

function help(): void {
  console.log(`Tonebridge - acoustic data link

  encode  --text "..." [--out f.wav] [--profile standard] [--fec balanced] [--gain 0.3] [--channel quiet] [--rate 48000]
          Render one frame of audio. Also: --file <path> to encode raw bytes as text.
  decode  <f.wav> [--profile standard] [--fec balanced] [--json]   # same profile/FEC as encode
          Pull every frame out of a recording.
  bench   [--profile standard] [--channel table]
          Time the DSP for one frame and report the airtime budget.
  selftest [--n 12] [--profiles all] [--channels all] [--verbose]
          Round-trip the modem through the channel model. Exit code 1 on any failure.
  matrix  [--n 6] [--fec balanced] [--payload 0] [--rate 48000]
          Profile x channel-model delivery matrix. --payload 0 means the largest legal frame.
  profiles
          List the air interfaces.

Every mode works offline; nothing here touches a network.`);
}

/**
 * `--profile`, `--fec` and `--rate` shape the plan. FEC has to be honoured on both sides of a
 * file round trip, so pass the same `--fec` to `decode` as you did to `encode`: the frame does not
 * self-describe its parity length, and inventing a "best guess" here would mean silently decoding
 * a corrupt frame instead of reporting that nothing matched.
 */
function planFrom(a: Args, sr: number) {
  const profile = profileById(str(a, 'profile', 'standard'));
  const fec = typeof a['fec'] === 'string' ? fecById(a['fec'] as string) : null;
  return makePlan(profile, sr, fec ? { bodyParity: fec.bodyParity, headerParity: fec.headerParity } : {});
}

function cmdEncode(a: Args): number {
  const text = str(a, 'text', 'Tonebridge: the room is the wire.');
  const sr = num(a, 'rate', 48000);
  const plan = planFrom(a, sr);
  const body = packText(text);
  const rendered = renderFrame(plan, body, { flags: FLAGS.WANTS_ACK, sender: num(a, 'node', 7), target: HDR.BROADCAST, msgId: crc16(new TextEncoder().encode(text)) & 0xff, chunkIdx: 0, chunkCount: 1 }, {
    gain: a['gain'] !== undefined ? (a['gain'] as number) : undefined,
  });
  const out = str(a, 'out', 'tonebridge.wav');
  writeFileSync(out, Buffer.from(encodeWav(rendered.wave, sr)));
  console.log(
    `wrote ${out}: ${rendered.wave.length} samples, ${(rendered.durationMs / 1000).toFixed(2)} s of air, ` +
      `${rendered.symbols.length} symbols, ${Math.round(plan.bitRate)} bps gross, overhead ${(rendered.overhead * 100).toFixed(0)}%`,
  );
  return 0;
}

function cmdDecode(a: Args): number {
  const file = a._[0];
  if (!file) {
    console.error('decode needs a .wav file');
    return 2;
  }
  const buf = new Uint8Array(readFileSync(file));
  const wav = decodeWav(buf);
  const plan = planFrom(a, wav.sampleRate);
  const frames = decodeRecording(wav.samples, wav.sampleRate, plan);
  if (!frames.length) {
    console.error('no frames decoded');
    return 1;
  }
  for (const f of frames) {
    const env = unpack(f.body);
    const text = env && env.kind === KIND.TEXT ? env.text : undefined;
    if (a['json']) {
      console.log(
        JSON.stringify({
          header: f.header,
          text: text ?? null,
          bytes: Array.from(f.body),
          stats: f.stats,
        }),
      );
    } else {
      console.log(
        `frame from node ${f.header.sender} -> ${f.header.target}  msg ${f.header.msgId}  body ${f.body.length} B  ` +
          `[SNR ${f.stats.snrDb.toFixed(1)} dB, FEC fixed ${f.stats.corrected} + ${f.stats.erasures} erasures, ` +
          `clock ${(f.stats.timingPpm >= 0 ? '+' : '') + f.stats.timingPpm.toFixed(0)} ppm]`,
      );
      if (text !== undefined) console.log(`  text: ${text}`);
    }
  }
  return 0;
}

function cmdBench(a: Args): number {
  const sr = 48000;
  const plan = planFrom(a, sr);
  const body = packText('x'.repeat(96));
  const t0 = performance.now();
  const rendered = renderFrame(plan, body, { flags: 0, sender: 1, msgId: 1 } as never);
  const t1 = performance.now();
  const noisy = applyChannel(rendered.wave, sr, presetById(str(a, 'channel', 'table')).model, mulberry32(9));
  const t2 = performance.now();
  const frames = decodeRecording(noisy, sr, plan);
  const t3 = performance.now();
  console.log(
    `render ${(t1 - t0).toFixed(1)} ms · channel model ${(t2 - t1).toFixed(1)} ms · receive ${(t3 - t2).toFixed(1)} ms` +
      ` for ${(rendered.durationMs / 1000).toFixed(2)} s of air (realtime factor ${((t3 - t0) / (rendered.durationMs / 1000)).toFixed(3)})`,
  );
  console.log(`decoded ${frames.length} frame(s), ${frames.length && frames[0]!.body.length === body.length ? 'payload matches' : 'MISMATCH'}`);
  return frames.length ? 0 : 1;
}

interface Row {
  label: string;
  detail: string;
  delivered: number;
  frames: number;
  bps: number;
  rxMs: number;
  pass: boolean;
}

async function cmdSelftest(a: Args): Promise<number> {
  const frames = Math.max(1, num(a, 'n', 8));
  const sr = num(a, 'rate', 48000);
  const rows: Row[] = [];
  const pad = (v: string | number, w: number) => String(v) + ' '.repeat(Math.max(0, w - String(v).length));

  // Gate 1: with the default FEC, every air interface must be flawless on the three
  // channels a normal device can be expected to meet.
  const baseline = ['bench', 'quiet', 'phone'];
  for (const pid of PROFILES.map((p) => p.id)) {
    for (const cid of baseline) {
      const res = await sweep({ sr, channel: presetById(cid).model, profiles: [pid], fecLevels: [str(a, 'fec', 'balanced')], frames, coalesce: false });
      const r = res[0]!;
      rows.push({
        label: `${r.profileName} / ${presetById(cid).name}`,
        detail: 'baseline, no retries',
        delivered: r.delivered,
        frames,
        bps: r.throughputBps,
        rxMs: r.rxMs,
        pass: r.delivered === frames,
      });
    }
  }
  // Gate 2: whatever the room is doing, the tuner must find a configuration that
  // never loses a frame - this is the promise the "Adapt to this room" button makes.
  for (const cid of CHANNEL_PRESETS.map((c) => c.id)) {
    const res = await sweep({ sr, channel: presetById(cid).model, frames, coalesce: false, payloadBytes: num(a, 'payload', 40) });
    const best = res[0]!;
    rows.push({
      label: `tune: ${presetById(cid).name}`,
      detail: `${best.profileName} + ${best.fecName} FEC, ${best.throughputBps.toFixed(0)} bps, ${res.length} candidates`,
      delivered: best.delivered,
      frames,
      bps: best.throughputBps,
      rxMs: best.rxMs,
      pass: best.delivered === frames,
    });
  }

  console.log(`\n${pad('case', 34)}${pad('result', 12)}${pad('bps', 7)}${pad('rx ms', 8)}  detail`);
  console.log('-'.repeat(110));
  let failures = 0;
  for (const r of rows) {
    if (!r.pass) failures++;
    console.log(
      `${pad(r.label, 34)}${pad(`${r.delivered}/${r.frames}${r.pass ? '' : ' FAIL'}`, 12)}${pad(r.bps.toFixed(0), 7)}${pad(r.rxMs.toFixed(1), 8)}  ${r.detail}`,
    );
    if (!r.pass && a['verbose']) console.log(`        ^ lost ${r.frames - r.delivered} frame(s) - ${r.detail}`);
  }
  console.log(
    failures === 0
      ? `\n${rows.length} checks passed: the modem holds every frame on the baseline channels, and the tuner always finds a clean configuration.\nExit 0.`
      : `\n${failures} of ${rows.length} checks failed.`,
  );
  return failures === 0 ? 0 : 1;
}

/**
 * The honest table: every profile against every room model, single shot, no retransmission
 * and no tuner. Expect gaps here - that is what the tuner in `selftest` (and in the Signal Lab
 * panel) exists to close. Payload size is the second axis people forget: a full-size frame
 * behaves differently from a short one, so `--payload` is exposed rather than hardcoded.
 */
async function cmdMatrix(a: Args): Promise<number> {
  const frames = Math.max(1, num(a, 'n', 6));
  const sr = num(a, 'rate', 48000);
  const fec = str(a, 'fec', 'balanced');
  const want = num(a, 'payload', 0);
  const chans = CHANNEL_PRESETS.map((c) => c.id);
  const pad = (v: string | number, w: number) => String(v) + ' '.repeat(Math.max(0, w - String(v).length));
  console.log(
    `\nprofile x room, ${fec} FEC, ${want ? want + ' B' : 'largest legal'} payload, ${frames} single-shot frames, no retries\n` +
      `bps = delivered user bytes per second of air for a clean run; a lost frame is not free, so it is not quoted.`,
  );
  console.log(pad('profile', 12) + chans.map((c) => pad(presetById(c).name, 20)).join(''));
  console.log('-'.repeat(12 + chans.length * 20));
  let holes = 0;
  for (const p of PROFILES) {
    const full = makePlan(p, sr).maxBody - 3; // 3 B of envelope header in packText
    const cells: string[] = [];
    for (const cid of chans) {
      const res = await sweep({
        sr,
        channel: presetById(cid).model,
        profiles: [p.id],
        fecLevels: [fec],
        frames,
        coalesce: false,
        payloadBytes: want || full,
      });
      const r = res[0]!;
      const lost = frames - r.delivered;
      if (lost) holes++;
      const rate = lost ? 'lost' : `${r.throughputBps.toFixed(0)}bps`;
      cells.push(pad(`${r.delivered}/${frames}${lost ? ` -${lost} ${rate}` : ` ${rate}`}`, 20));
    }
    console.log(pad(p.name, 12) + cells.join(''));
  }
  console.log(
    holes === 0
      ? `\nNo holes: every profile delivered every frame in every room at ${fec} FEC.`
      : `\n${holes} hole(s) above. Run the tuner (selftest, or "Adapt to this room" in the Signal Lab) to pick a profile per room.`,
  );
  return 0;
}

function cmdProfiles(): number {
  for (const p of PROFILES) {
    const plan = makePlan(p, 48000);
    console.log(
      `${p.id.padEnd(11)} ${p.name.padEnd(10)} ${plan.mfsk}-FSK ${plan.bitRate.toFixed(0).padStart(4)} bps  ` +
        `${plan.tones.map((t) => Math.round(t)).join('/')} Hz  FEC ${p.bodyParity} B  max ${p.maxBody} B/frame  (${p.band})`,
    );
    console.log(`  ${p.blurb}`);
  }
  return 0;
}

const args = parseArgs(process.argv.slice(2));
// The subcommand is the first positional; shift it off so every command can read
// `a._[0]` as its own first argument.
const cmd = args._.shift() ?? 'help';
let code = 0;
switch (cmd) {
  case 'encode':
    code = cmdEncode(args);
    break;
  case 'decode':
    code = cmdDecode(args);
    break;
  case 'bench':
    code = cmdBench(args);
    break;
  case 'selftest':
    code = await cmdSelftest(args);
    break;
  case 'matrix':
    code = await cmdMatrix(args);
    break;
  case 'profiles':
    code = cmdProfiles();
    break;
  default:
    help();
    code = cmd === 'help' ? 0 : 2;
}
process.exit(code);
