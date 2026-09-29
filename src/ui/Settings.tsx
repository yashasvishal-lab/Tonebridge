import { useEffect, useState, type ReactNode } from 'react';
import { useApp, useEngine, bytes as fmtBytes } from './hooks.ts';
import { Button, Chip, Field, Icon, Panel } from './atoms.tsx';
import { FEC_LEVELS, PROFILES } from '../core/profiles.ts';
import { HDR } from '../core/types.ts';
import { IL_COLS, ERASURE_REL, MIN_FRAME_CONF } from '../core/frame.ts';
import { storageAvailable } from '../link/storage.ts';

export function SettingsView(): ReactNode {
  const engine = useEngine();
  const m = useApp((x) => ({
    settings: x.settings,
    plan: x.plan,
    playable: x.playable,
    graph: x.graph,
    wakeLock: x.wakeLock,
    stats: x.stats,
    crypto: x.crypto,
    ready: x.ready,
  }));
  const s = m.settings;
  const [diag, setDiag] = useState<Record<string, string>>({});

  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: unknown; audioContext?: unknown };
    setDiag({
      'user agent': typeof navigator !== 'undefined' ? navigator.userAgent : 'node',
      'secure context': typeof window !== 'undefined' ? String(window.isSecureContext) : 'n/a',
      AudioWorklet: typeof AudioWorkletNode !== 'undefined' ? 'supported' : 'missing (capture falls back to a script processor)',
      'Wake Lock API': nav.wakeLock ? 'supported' : 'missing',
      'setSinkId (output choice)': typeof HTMLAudioElement !== 'undefined' && 'setSinkId' in HTMLAudioElement.prototype ? 'supported' : 'missing (system default is used)',
      'WebCrypto subtle': typeof crypto !== 'undefined' && crypto.subtle ? 'available' : 'MISSING - encryption is unavailable',
      'device sample rate': `${m.graph.sampleRate} Hz`,
      'capture path': m.graph.worklet ? 'AudioWorklet' : 'script processor',
      'localStorage': storageAvailable() ? 'available' : 'blocked (settings will not persist)',
    });
  }, [m.graph.sampleRate, m.graph.worklet]);

  return (
    <div className="grid grid-two">
      <Panel title="This node" icon="radio" note="Two devices on the same air can coexist; they only talk when addressed. 255 is the broadcast address.">
        <div className="row">
          <Field label="Node id (1–254)" htmlFor="node">
            <input
              id="node"
              type="number"
              min={1}
              max={254}
              value={s.node}
              onChange={(e) => engine.setSettings({ node: Number(e.target.value) || 1 })}
            />
          </Field>
          <Field label="Announced name" htmlFor="name">
            <input id="name" maxLength={24} value={s.name} onChange={(e) => engine.setSettings({ name: e.target.value })} />
          </Field>
        </div>
        <Field label={`Transmit level ${(s.txGain * 100).toFixed(0)}%`} htmlFor="gain">
          <input id="gain" type="range" min={0.04} max={0.35} step={0.01} value={s.txGain} onChange={(e) => engine.setSettings({ txGain: Number(e.target.value) })} />
        </Field>
        <p className="msg-err">
          <Icon name="alert" /> This is an intentional loud tone generator. Keep the device away from your ear, warn anyone nearby, and never exceed the
          ceiling built into this field (0.35 full scale). Ultrasound is inaudible and still damages hearing: the Ultrasonic profile is the one to be most
          careful with.
        </p>
      </Panel>

      <Panel title="Capture" icon="mic" note="Loopback and the simulator need no microphone permission and run the identical modulator and demodulator - useful on a desk, on a server, or when a browser refuses the mic.">
        <div className="radios">
          {(['mic', 'loopback', 'sim'] as const).map((cap) => (
            <label key={cap} className={`radio-card${s.capture === cap ? ' radio-on' : ''}`}>
              <input type="radio" name="capture" value={cap} checked={s.capture === cap} onChange={() => engine.setSettings({ capture: cap })} />
              <b>{{ mic: 'Microphone', loopback: 'Loopback', sim: 'Room simulator' }[cap]}</b>
              <span>
                {cap === 'mic'
                  ? 'Real acoustics: speaker to air to microphone. The only mode that proves the room works.'
                  : cap === 'loopback'
                    ? 'The transmitted samples are handed straight to the receiver. No permission, no sound, still every codec path.'
                    : 'The transmitted samples pass through the room model before the receiver. Reproducible, measurable, silent.'}
              </span>
            </label>
          ))}
        </div>
        <div className="row">
          <Field label="Input" htmlFor="in">
            <select id="in" value={s.inputDeviceId ?? ''} onChange={(e) => engine.setSettings({ inputDeviceId: e.target.value || null })}>
              <option value="">system default</option>
              {m.graph.inputs.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `input ${i + 1}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Output" htmlFor="out">
            <select id="out" value={s.outputDeviceId ?? ''} onChange={(e) => engine.setSettings({ outputDeviceId: e.target.value || null })}>
              <option value="">system default</option>
              {m.graph.outputs.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `output ${i + 1}`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="row row-btns">
          <Button onClick={() => void engine.startCapture()} disabled={!m.ready}>
            <Icon name='refresh' /> Restart capture
          </Button>
          <Button onClick={() => void engine.audio.detectDevices()}>
            <Icon name='refresh' /> Re-list devices
          </Button>
          <Button tone={m.wakeLock ? 'primary' : 'default'} onClick={() => void engine.toggleWakeLock()}>
            {m.wakeLock ? 'Wake lock held' : 'Keep screen awake'}
          </Button>
        </div>
        {m.graph.mic === 'denied' ? <p className="msg-err">Microphone access was refused. Allow it for this page, then restart capture.</p> : null}
      </Panel>

      <Panel title="Air interface" icon="wave" note="Tones are snapped to exact DFT bins of whatever sample rate the device offers, which is why the same profile works on a 44.1 kHz laptop and a 48 kHz phone.">
        <div className="profiles">
          {PROFILES.map((p) => {
            const active = p.id === s.profileId;
            return (
              <label key={p.id} className={`profile-card${active ? ' profile-on' : ''}`}>
                <input type="radio" name="profile" value={p.id} checked={active} onChange={() => engine.setSettings({ profileId: p.id })} />
                <span className="profile-head">
                  <b>{p.name}</b>
                  <Chip tone={active ? 'ok' : 'neutral'}>{p.band}</Chip>
                </span>
                <span className="mono profile-specs">
                  {p.tones.length}-FSK · {p.symMs} ms · {p.tones.map((t) => Math.round(t / 10) / 100).join('/')} kHz
                </span>
                <span className="profile-blurb">{p.blurb}</span>
              </label>
            );
          })}
        </div>
        <div className="fec-row">
          {FEC_LEVELS.map((f) => (
            <label key={f.id} className={`fec-card${s.fecId === f.id ? ' profile-on' : ''}`}>
              <input type="radio" name="fec" value={f.id} checked={s.fecId === f.id} onChange={() => engine.setSettings({ fecId: f.id })} />
              <b>
                {f.name} · {f.bodyParity} B
              </b>
              <span>{f.blurb}</span>
            </label>
          ))}
        </div>
        {!m.playable.ok ? <p className="msg-err">{m.playable.warning}</p> : null}
        <details className="adv">
          <summary>Advanced: override the symbol period and tone set</summary>
          <div className="row">
            <Field label="Symbol ms (0 = profile)" htmlFor="sym">
              <input id="sym" type="number" min={0} max={200} step={0.5} value={s.symMs} onChange={(e) => engine.setSettings({ symMs: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="Tones, Hz (empty = profile)" htmlFor="tones">
              <input id="tones" value={s.tones} placeholder="1200 1500 1800 2100" onChange={(e) => engine.setSettings({ tones: e.target.value })} />
            </Field>
          </div>
          <p className="muted">
            Overrides are re-quantised to bins like everything else, so this stays a coherent receiver. Use it to sit in a quiet part of the spectrum or to
            match a device with a tweeter that hates 3 kHz.
          </p>
        </details>
      </Panel>

      <Panel title="Reliability behaviour" icon="target">
        <label className="check">
          <input type="checkbox" checked={s.autoAck} onChange={(e) => engine.setSettings({ autoAck: e.target.checked })} />
          <span>
            <b>Acknowledge and retransmit (stop-and-wait ARQ)</b>
            <em>Off means fire-and-forget: one-way, faster, and silent about what did not arrive. Keep it on for anything you care about.</em>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.beacon} onChange={(e) => void engine.setBeacon(e.target.checked)} />
          <span>
            <b>Announce this node every 20 s</b>
            <em>Lets other devices list you by name. Costs a couple of seconds of air per minute.</em>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.saveTranscripts} onChange={(e) => engine.setSettings({ saveTranscripts: e.target.checked })} />
          <span>
            <b>Keep text messages in this browser</b>
            <em>Stored in localStorage as readable text, on this device only, never synced. Do not turn this on for secrets, and clear it on a shared machine.</em>
          </span>
        </label>
        <div className="row row-btns">
          <Button onClick={() => engine.resetStats()}>
            <Icon name="refresh" /> Zero the counters
          </Button>
          <Button tone="danger" onClick={() => engine.clearTranscripts()}>
            <Icon name="x" /> Erase stored transcripts
          </Button>
        </div>
        <p className="muted">
          Lifetime of this session: {m.stats.framesSent} frames out, {m.stats.framesRecv} in, {m.stats.retries} retransmissions, {fmtBytes(m.stats.bytesSent)} of
          payload, {(m.stats.airSeconds).toFixed(1)} s of air. {m.crypto.secure ? 'Channel sealed.' : 'Channel open.'}
        </p>
      </Panel>

      <Panel title="Protocol and platform" icon="info" note="TBP-1, version 1. Everything here is fixed by the wire format, which is why two devices on different sample rates interoperate.">
        <div className="kv">
          <span>Header</span>
          <b className="mono">
            {HDR.BYTES} B: version, flags, profile tag, sender, target, msg id, chunk index, chunk count, body length, CRC-16 — then {m.plan?.headerParity ?? 0} parity bytes
          </b>
          <span>Body</span>
          <b className="mono">CRC-32 ‖ payload ‖ {m.plan?.bodyParity ?? 0} parity bytes, interleaved over {IL_COLS} columns</b>
          <span>Erasure policy</span>
          <b className="mono">symbols below {ERASURE_REL} confidence are candidates; frames below {MIN_FRAME_CONF} mean confidence are ignored</b>
          <span>Frame</span>
          <b className="mono">
            {m.plan ? `${m.plan.preSyms} sync symbols + ${m.plan.headerBytes * 8 / Math.max(1, m.plan.bitsPerSymbol)} header + body, ${((m.plan.leadSamples + m.plan.tailSamples) / m.plan.sr * 1000).toFixed(0)} ms of ramps` : '—'}
          </b>
          <span>Max frame</span>
          <b className="mono">{m.plan ? `${m.plan.maxBody} B body · ${(m.plan.maxFrameMs / 1000).toFixed(2)} s of air · chunked at ${m.plan.chunkBody} B` : '—'}</b>
        </div>
        <div className="diag">
          {Object.entries(diag).map(([k, v]) => (
            <p key={k}>
              <span>{k}</span>
              <code>{v}</code>
            </p>
          ))}
        </div>
      </Panel>
    </div>
  );
}
