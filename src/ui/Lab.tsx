import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp, useEngine, db, dur } from './hooks.ts';
import { Button, Chip, Field, Icon, Panel, Stat } from './atoms.tsx';
import { CHANNEL_PRESETS } from '../core/channel.ts';
import { FEC_LEVELS } from '../core/profiles.ts';
import type { AdaptResult } from '../core/adapt.ts';

/**
 * Signal Lab: the receiver's own numbers on the screen.
 *
 * Everything drawn here comes from data the demodulator already keeps - the coarse
 * symbol window it scans for sync, the discrimination ratio per slot, the SNR of each
 * decoded frame - so what you see is what the decoder actually decided, not a second
 * measurement that could disagree with it.
 */
export function LabView(): ReactNode {
  const engine = useEngine();
  const m = useApp((x) => ({
    scope: x.scope,
    rx: x.rx,
    stats: x.stats,
    plan: x.plan,
    selftest: x.selftest,
    matrix: x.matrix,
    settings: x.settings,
    graph: x.graph,
    profile: x.profile,
    fec: x.fec,
  }));
  const [frames, setFrames] = useState(6);
  const strip = useRef<HTMLCanvasElement | null>(null);
  const conf = useRef<HTMLCanvasElement | null>(null);
  const spec = useRef<HTMLCanvasElement | null>(null);
  const trend = useRef<HTMLCanvasElement | null>(null);
  const snrHist = useRef<{ v: number; at: number }[]>([]);
  const lastFrames = useRef(-1);

  // One SNR sample per decoded frame, for the trend line.
  useEffect(() => {
    const unsub = engine.store.subscribe(() => {
      const cur = engine.store.get();
      const n = cur.stats.framesRecv;
      if (n === lastFrames.current) return;
      lastFrames.current = n;
      const f = engine.demodulator?.lastFrame;
      if (f) snrHist.current = [...snrHist.current.slice(-119), { v: f.stats.snrDb, at: n }];
    });
    return unsub;
  }, [engine]);

  useEffect(() => {
    let raf = 0;
    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      const demod = engine.demodulator;
      const plan = engine.currentPlan;
      if (!plan) return;
      const mfsk = plan.mfsk;
      const n = 96;
      if (strip.current && demod) {
        const ctx = strip.current.getContext('2d');
        if (ctx) {
          const w = strip.current.width;
          const h = strip.current.height;
          ctx.clearRect(0, 0, w, h);
          const tr = demod.trace(n);
          const cw = w / n;
          const ch = h / mfsk;
          for (let i = 0; i < tr.idx.length; i++) {
            for (let t = 0; t < mfsk; t++) {
              const on = tr.idx[i] === t;
              const rel = tr.rel[i] ?? 0;
              ctx.fillStyle = on ? `hsl(${180 + Math.min(60, rel * 18)} 85% ${Math.min(72, 34 + rel * 9)}%)` : 'rgba(120,160,190,0.06)';
              ctx.fillRect(i * cw, h - (t + 1) * ch, Math.ceil(cw), ch - 1);
            }
          }
        }
      }
      if (conf.current && demod) {
        const ctx = conf.current.getContext('2d');
        if (ctx) {
          const w = conf.current.width;
          const h = conf.current.height;
          ctx.clearRect(0, 0, w, h);
          const tr = demod.trace(n);
          const maxRel = 6;
          const y = (v: number): number => h - Math.min(1, Math.max(0, v / maxRel)) * h;
          ctx.strokeStyle = 'rgba(255,180,84,0.55)';
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(0, y(2.2));
          ctx.lineTo(w, y(2.2));
          ctx.stroke();
          ctx.strokeStyle = 'rgba(255,90,110,0.5)';
          ctx.beginPath();
          ctx.moveTo(0, y(1.35));
          ctx.lineTo(w, y(1.35));
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.strokeStyle = '#6ee7c8';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          for (let i = 0; i < tr.rel.length; i++) {
            const x = (i / (tr.rel.length - 1 || 1)) * w;
            const v = tr.rel[i] ?? 0;
            if (i === 0) ctx.moveTo(x, y(v));
            else ctx.lineTo(x, y(v));
          }
          ctx.stroke();
          ctx.fillStyle = 'rgba(150,180,200,0.75)';
          ctx.font = '10px ui-monospace, monospace';
          ctx.fillText('2.2 = erasure threshold', 6, y(2.2) - 3);
          ctx.fillText('1.35 = frame confidence floor', 6, y(1.35) - 3);
        }
      }
      if (trend.current) {
        const ctx = trend.current.getContext('2d');
        if (ctx) {
          const w = trend.current.width;
          const h = trend.current.height;
          ctx.clearRect(0, 0, w, h);
          const pts = snrHist.current;
          ctx.strokeStyle = 'rgba(150,180,200,0.25)';
          for (const lvl of [6, 12, 20]) {
            const y = h - (lvl / 32) * h;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
            ctx.fillStyle = 'rgba(150,180,200,0.55)';
            ctx.font = '9px ui-monospace, monospace';
            ctx.fillText(`${lvl}`, 2, y - 2);
          }
          if (pts.length > 1) {
            ctx.strokeStyle = '#7fd6ff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            pts.forEach((p, i) => {
              const x = (i / (pts.length - 1)) * w;
              const y = h - Math.min(1, Math.max(0, p.v / 32)) * h;
              if (i === 0) ctx.moveTo(x, y);
              else ctx.lineTo(x, y);
            });
            ctx.stroke();
            for (const p of pts) {
              const i = pts.indexOf(p);
              const x = (i / (pts.length - 1)) * w;
              const y = h - Math.min(1, Math.max(0, p.v / 32)) * h;
              ctx.fillStyle = p.v < 8 ? 'rgba(255,120,120,0.9)' : 'rgba(110,231,200,0.9)';
              ctx.fillRect(x - 1, y - 1, 2.5, 2.5);
            }
          }
        }
      }
      const sc = spec.current;
      if (sc) {
        const ctx = sc.getContext('2d');
        if (ctx) {
          const w = sc.width;
          const h = sc.height;
          ctx.clearRect(0, 0, w, h);
          const an = engine.audio.analyser;
          if (an) {
            const bins = new Uint8Array(an.frequencyBinCount);
            an.getByteFrequencyData(bins as unknown as Uint8Array<ArrayBuffer>);
            const nyq = engine.sr / 2;
            const bars = 128;
            for (let b = 0; b < bars; b++) {
              const f0 = (b / bars) * nyq;
              const f1 = ((b + 1) / bars) * nyq;
              const i0 = Math.floor((f0 / nyq) * bins.length);
              const i1 = Math.max(i0 + 1, Math.floor((f1 / nyq) * bins.length));
              let peak = 0;
              for (let i = i0; i < i1 && i < bins.length; i++) peak = Math.max(peak, bins[i]!);
              const v = peak / 255;
              ctx.fillStyle = `hsl(${200 - v * 90} 80% ${20 + v * 45}%)`;
              ctx.fillRect((b / bars) * w, h - v * h, w / bars - 1, v * h);
            }
            ctx.fillStyle = 'rgba(255,220,150,0.85)';
            for (const t of plan.tones) {
              const x = (t / nyq) * w;
              ctx.fillRect(x - 0.5, 0, 1, 6);
            }
          } else {
            ctx.fillStyle = 'rgba(150,180,200,0.5)';
            ctx.font = '11px ui-monospace, monospace';
            ctx.fillText('start the modem to see the input spectrum', 10, h / 2);
          }
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  return (
    <div className="grid grid-lab">
      <Panel
        title="Receiver, live"
        icon="lab"
        note="Rows: which tone won each symbol slot (preamble → header → body). Then the discrimination ratio the decoder is working with, then the input spectrum with the plan's tone centres marked."
        right={<Chip tone={m.scope.state === 'locked' ? 'ok' : m.scope.state === 'hunting' ? 'warn' : 'neutral'}>{m.scope.state}</Chip>}
      >
        <div className="scopes">
          <figure>
            <canvas ref={strip} width={720} height={m.plan ? m.plan.mfsk * 26 : 104} />
            <figcaption>
              tone chosen per symbol slot ({m.plan?.mfsk}-FSK, one column every {m.plan ? ((m.plan.subStep / m.plan.sr) * 1000).toFixed(2) : '—'} ms)
            </figcaption>
          </figure>
          <figure>
            <canvas ref={conf} width={720} height={110} />
            <figcaption>per-slot discrimination - the decoder starts guessing below the red line</figcaption>
          </figure>
          <figure>
            <canvas ref={trend} width={720} height={74} />
            <figcaption>frame SNR history, newest on the right (0 – 32 dB)</figcaption>
          </figure>
          <figure>
            <canvas ref={spec} width={720} height={130} />
            <figcaption>input spectrum, 0 – {Math.round(engine.sr / 2000)} kHz</figcaption>
          </figure>
        </div>
        <div className="stats">
          <Stat label="level" value={db(m.scope.levelDb, 'dBFS')} hint="mean-square of the last frame window" />
          <Stat label="noise floor" value={db(m.scope.noiseFloorDb, 'dBFS')} hint="tracked by the receiver, falls fast and rises slowly" />
          <Stat label="excess" value={db(m.scope.excessDb)} hint="how far the current signal is above that floor" tone={m.scope.excessDb > 10 ? 'ok' : m.scope.excessDb > 4 ? 'warn' : 'err'} />
          <Stat label="frame SNR" value={db(m.scope.snrDb)} tone={m.scope.snrDb > 12 ? 'ok' : 'warn'} />
          <Stat label="confidence" value={m.scope.lastConf ? `${m.scope.lastConf.toFixed(2)} (min ${m.scope.lastMinConf.toFixed(2)})` : '—'} hint="mean and worst per-symbol tone discrimination over the last frame" />
          <Stat label="clock" value={`${m.scope.ppm >= 0 ? '+' : ''}${m.scope.ppm.toFixed(0)} ppm`} hint="residual symbol-rate error the receiver had to absorb" tone={Math.abs(m.scope.ppm) < 120 ? 'ok' : 'warn'} />
        </div>
        <div className="counters mono">
          <span>sync candidates {m.rx.counters.candidates}</span>
          <span>headers decoded {m.rx.counters.headerOk}</span>
          <span>bodies decoded {m.rx.counters.bodyOk}</span>
          <span>FEC exhausted {m.rx.counters.bodyFail}</span>
          <span>sync rejected {m.rx.counters.syncRejects}</span>
          {m.rx.lastError ? <span className="err">last error: {m.rx.lastError}</span> : null}
        </div>
      </Panel>

      <div className="col">
        <Panel
          title="Room model"
          icon="speaker"
          note="Used by the tuner, the reliability map and the simulator capture mode. It is a model, not a measurement of your room - the microphone path is where reality enters."
        >
          <div className="row">
            <Field label="Preset" htmlFor="chan">
              <select id="chan" value={m.settings.channelPreset} onChange={(e) => engine.setSettings({ channelPreset: e.target.value })}>
                {CHANNEL_PRESETS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Noise ${m.settings.snrDb} dB SNR`} htmlFor="snr">
              <input id="snr" type="range" min={0} max={40} step={1} value={m.settings.snrDb} onChange={(e) => engine.setSettings({ snrDb: Number(e.target.value) })} />
            </Field>
          </div>
          <p className="muted">{engine.describeChannel()}</p>
        </Panel>

        <Panel
          title="Tune to this room"
          icon="refresh"
          note="Renders every air interface × FEC strength, pushes each through the room model, decodes with the real receiver and ranks the survivors. The same code runs in the CLI."
          right={
            <Field label="frames" htmlFor="nf">
              <select id="nf" value={frames} onChange={(e) => setFrames(Number(e.target.value))}>
                <option value={3}>3 · quick</option>
                <option value={6}>6 · normal</option>
                <option value={12}>12 · thorough</option>
              </select>
            </Field>
          }
        >
          <div className="row row-btns">
            <Button tone="primary" disabled={m.selftest.running} onClick={() => void engine.runAdapt(frames)}>
              <Icon name={m.selftest.running ? 'stop' : 'play'} /> {m.selftest.running ? 'Tuning…' : 'Adapt and apply'}
            </Button>
            <Button disabled={m.selftest.running} onClick={() => void engine.runAdapt(frames, undefined, undefined, false)} title="Measure without changing the settings">
              measure only
            </Button>
            <Button disabled={m.selftest.running} onClick={() => void engine.runMatrix(frames)} title="Every profile against every room preset">
              reliability map
            </Button>
          </div>
          {m.selftest.running ? (
            <div className="progress">
              <div className="progress-fill" style={{ width: `${(m.selftest.progress * 100).toFixed(1)}%` }} />
              <span className="mono">{m.selftest.label}</span>
            </div>
          ) : m.selftest.label ? (
            <p className="note">{m.selftest.label}</p>
          ) : null}
          {m.selftest.error ? <p className="msg-err">{m.selftest.error}</p> : null}
          {m.selftest.results.length ? <ResultTable results={m.selftest.results} /> : <p className="muted">No measurement yet.</p>}
        </Panel>

        <Panel title="Reliability map" icon="info" note="Delivered frames per combination, at the FEC strength shown. Green means every frame survived unaided; the numbers are the same ones the CLI prints.">
          {m.matrix.length ? <Matrix cells={m.matrix} fec={m.fec?.name ?? ''} /> : <p className="muted">Run “reliability map” to fill this in.</p>}
        </Panel>
      </div>
    </div>
  );
}

function ResultTable({ results }: { results: AdaptResult[] }): ReactNode {
  const engine = useEngine();
  const shown = results.slice(0, 10);
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>air interface</th>
            <th>FEC</th>
            <th title="frames that arrived bit-exact, without retransmission">delivered</th>
            <th title="payload bits per second of airtime, not including FEC or retries">bps</th>
            <th title="average symbols repaired per frame by Reed-Solomon">FEC load</th>
            <th title="wall-clock time to demodulate one frame on this machine">rx</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={`${r.profileId}-${r.fecId}`} className={r.delivered === r.frames ? 'row-ok' : r.delivered === 0 ? 'row-bad' : ''}>
              <td>{r.profileName}</td>
              <td>{r.fecName}</td>
              <td className="mono">
                {r.delivered}/{r.frames}
              </td>
              <td className="mono">{r.throughputBps.toFixed(0)}</td>
              <td className="mono">{r.fecSymbols.toFixed(1)}</td>
              <td className="mono">{r.rxMs.toFixed(1)} ms</td>
              <td>
                <Button
                  tone="ghost"
                  onClick={() => engine.setSettings({ profileId: r.profileId, fecId: r.fecId })}
                  title={`Switch to ${r.profileName} with ${r.fecName} FEC (${dur(r.frameMs)} per frame)`}
                >
                  apply
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Matrix({ cells, fec }: { cells: { profileName: string; channelName: string; delivered: number; frames: number }[]; fec: string }): ReactNode {
  const chans = Array.from(new Set(cells.map((c) => c.channelName)));
  const profs = Array.from(new Set(cells.map((c) => c.profileName)));
  return (
    <div className="table-wrap">
      <table className="table table-map">
        <thead>
          <tr>
            <th>{fec} FEC</th>
            {chans.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {profs.map((p) => (
            <tr key={p}>
              <td>{p}</td>
              {chans.map((c) => {
                const cell = cells.find((x) => x.profileName === p && x.channelName === c);
                const rate = cell ? cell.delivered / cell.frames : 0;
                return (
                  <td key={c} className={`cell${rate === 1 ? ' cell-ok' : rate === 0 ? ' cell-bad' : ' cell-mid'}`} title={cell ? `${cell.delivered} of ${cell.frames} frames delivered without help` : 'not measured'}>
                    {cell ? `${Math.round(rate * 100)}%` : '—'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Exposed for the Settings view so both places agree on what FEC means. */
export const FEC_BLURBS = FEC_LEVELS.map((f) => ({ id: f.id, name: f.name, blurb: f.blurb }));
