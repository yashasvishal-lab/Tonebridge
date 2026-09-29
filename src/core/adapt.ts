/**
 * Room adaptation.
 *
 * The hard truth about sound in a room is that a bad channel is *specific*: fixed
 * reflections produce a fixed comb of notches, so a frame that died in a particular
 * way tends to die the same way. Guessing an air interface is therefore worse than
 * measuring one. This module renders candidate configurations, pushes them through
 * the channel model, decodes them with the production receiver, and ranks what it
 * found. The Signal Lab in the UI calls exactly this code, and so does the test
 * suite - which is how "it works in the browser" stays an honest claim.
 */

import type { ChannelModel } from './channel.ts';
import { applyChannel, mulberry32 } from './channel.ts';
import type { Plan, Profile } from './types.ts';
import { FEC_LEVELS, makePlan, profileById, type FecLevel, fecById } from './profiles.ts';
import { renderFrame } from './tx.ts';
import { decodeRecording } from './rx.ts';

export interface AdaptResult {
  profileId: string;
  profileName: string;
  fecId: string;
  fecName: string;
  frames: number;
  delivered: number;
  lost: number;
  payloadBytes: number;
  frameMs: number;
  throughputBps: number;
  fecSymbols: number;
  rxMs: number;
  score: number;
  plan: Plan;
  profile: Profile;
  fec: FecLevel;
}

export interface AdaptOptions {
  sr: number;
  channel: ChannelModel;
  /** Frames to try per combination. */
  frames?: number;
  profiles?: string[];
  fecLevels?: string[];
  payloadBytes?: number;
  seed?: number;
  onProgress?: (done: number, total: number, label: string) => void;
  /** Yield to the event loop between combinations so a browser tab stays paintable. */
  coalesce?: boolean;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function payloadFor(rand: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (rand() * 256) | 0;
  return out;
}

export async function sweep(opts: AdaptOptions): Promise<AdaptResult[]> {
  const frames = Math.max(1, opts.frames ?? 6);
  const seed = opts.seed ?? 0x5eed17;
  const profileIds = opts.profiles ?? ['standard', 'robust', 'sprint', 'ultrasonic', 'deep'];
  const fecIds = opts.fecLevels ?? FEC_LEVELS.map((f) => f.id);
  const want = opts.payloadBytes ?? 40;
  const results: AdaptResult[] = [];
  const total = profileIds.length * fecIds.length;
  let done = 0;

  for (const pid of profileIds) {
    for (const fid of fecIds) {
      const profile = profileById(pid);
      const fec = fecById(fid);
      const plan = makePlan(profile, opts.sr, { bodyParity: fec.bodyParity, headerParity: fec.headerParity });
      const n = Math.max(8, Math.min(want, plan.maxBody));
      const rand = mulberry32(seed ^ (pid.length * 7919 + fid.length * 104729 + n));
      let delivered = 0;
      let rxMs = 0;
      let fecSymbols = 0;
      let frameMs = 0;
      for (let t = 0; t < frames; t++) {
        const body = payloadFor(rand, n);
        const rendered = renderFrame(plan, body, { flags: 0, sender: 1, target: 0xff, msgId: t, chunkIdx: 0, chunkCount: 1 }, { gain: plan.txGain });
        const noisy = applyChannel(rendered.wave, opts.sr, opts.channel, rand);
        frameMs = rendered.durationMs;
        const t0 = performance.now();
        const found = decodeRecording(noisy, opts.sr, plan);
        rxMs += performance.now() - t0;
        const hit = found.some((f) => {
          if (f.body.length !== body.length) return false;
          for (let i = 0; i < f.body.length; i++) if (f.body[i] !== body[i]) return false;
          return true;
        });
        if (hit) {
          delivered++;
          const fr = found.find((f) => f.body.length === body.length);
          if (fr) fecSymbols += fr.stats.corrected + fr.stats.erasures;
        }
      }
      const throughputBps = frameMs > 0 ? (n * 8) / (frameMs / 1000) : 0;
      const rate = delivered / frames;
      // Delivery first, then speed, then how little FEC it needed to get there.
      const score = rate * rate * 1e6 + (rate === 1 ? throughputBps : 0) * 10 - (rate === 1 ? fecSymbols / frames : 0);
      results.push({
        profileId: pid,
        profileName: profile.name,
        fecId: fid,
        fecName: fec.name,
        frames,
        delivered,
        lost: frames - delivered,
        payloadBytes: n,
        frameMs,
        throughputBps,
        fecSymbols: fecSymbols / frames,
        rxMs: rxMs / frames,
        score,
        plan,
        profile,
        fec,
      });
      done++;
      opts.onProgress?.(done, total, `${profile.name} · ${fec.name}`);
      if (opts.coalesce !== false) await tick();
    }
  }
  return results.sort((a, b) => b.score - a.score);
}

export interface AdaptChoice {
  plan: Plan;
  profile: Profile;
  fec: FecLevel;
  results: AdaptResult[];
  /** False when nothing achieved a clean sweep; the best effort is still returned. */
  confident: boolean;
}

export async function pickBest(opts: AdaptOptions): Promise<AdaptChoice> {
  const results = await sweep(opts);
  const best = results[0];
  if (!best) throw new Error('no combinations were tried');
  return {
    plan: best.plan,
    profile: best.profile,
    fec: best.fec,
    results,
    confident: best.delivered === best.frames,
  };
}
