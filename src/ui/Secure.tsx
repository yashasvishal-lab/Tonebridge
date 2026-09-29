import { useState, type ReactNode } from 'react';
import { useApp, useEngine } from './hooks.ts';
import { Button, Chip, Field, Icon, Panel } from './atoms.tsx';

/**
 * Security, as a user-visible thing rather than a footnote.
 *
 * Two mechanisms, because they answer different threats: a shared passphrase (offline
 * key, no interaction needed, vulnerable to a weak code) and an interactive ECDH
 * handshake with a short authenticated code read aloud (immune to a passive attacker
 * in the room, needs two humans). Both end at the same place: a non-extractable
 * AES-GCM-256 key that only ever lives in memory.
 */
export function SecureView(): ReactNode {
  const engine = useEngine();
  const c = useApp((m) => m.crypto);
  const stats = useApp((m) => m.stats);
  const [pass, setPass] = useState('');
  const [err, setErr] = useState('');
  const [show, setShow] = useState(false);

  const strength = (() => {
    const n = pass.length;
    let classes = 0;
    for (const re of [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/]) if (re.test(pass)) classes++;
    const score = Math.min(4, Math.floor((n / 8) * classes));
    return ['weak', 'fair', 'good', 'strong', 'excellent'][Math.max(0, Math.min(4, score))]!;
  })();

  return (
    <div className="grid grid-two">
      <Panel
        title="Channel security"
        icon="shield"
        right={<Chip tone={c.secure ? 'ok' : c.mode === 'open' ? 'neutral' : 'warn'} title="Frames are only marked sealed when the key exists and has been authenticated">{c.label}</Chip>}
      >
        <div className="kv">
          <span>Mode</span>
          <b>{c.mode === 'open' ? 'open — anyone in range can read' : c.mode === 'psk' ? 'passphrase-derived key' : 'paired key (ECDH P-256)'}</b>
          <span>Cipher</span>
          <b className="mono">AES-GCM 256-bit, 96-bit IV, 128-bit tag</b>
          <span>Key fingerprint</span>
          <b className="mono">{c.fingerprint || '—'}</b>
          <span>Frame authentication failures</span>
          <b className="mono">{stats.framesRejected}</b>
        </div>
        <p className="muted">
            Every frame's FEC header is used as the cipher's additional authenticated data, so an attacker who flips a routing byte, a chunk index or a
            message id changes the ciphertext, and the frame is dropped before it can misassemble a transfer.
        </p>
        {c.mode !== 'open' ? (
          <div className="row row-btns">
            <Button tone="danger" onClick={() => engine.clearKey()}>
              <Icon name="x" /> Forget the key
            </Button>
          </div>
        ) : null}
      </Panel>

      <Panel title="Passphrase" icon="lock" note="PBKDF2-SHA256, 250 000 rounds, salt bound to the app. Nothing is written to disk, and there is deliberately no key check on the air: an offline oracle is the last thing a shared-secret channel needs.">
        <Field label="Shared code" htmlFor="pass">
          <div className="row-inline">
            <input
              id="pass"
              type={show ? 'text' : 'password'}
              value={pass}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setPass(e.target.value);
                setErr('');
              }}
              placeholder="at least 8 characters, ideally 4 words"
            />
            <Button tone="ghost" onClick={() => setShow((v) => !v)} title={show ? 'hide' : 'show'}>
              {show ? 'hide' : 'show'}
            </Button>
          </div>
        </Field>
        <p className="muted">
          Strength when typed: <b>{pass ? strength : 'nothing yet'}</b>. Anyone with the same code can read these frames, so pick one that is not guessable
          from the room you are in.
        </p>
        <div className="row row-btns">
          <Button
            tone="primary"
            onClick={() => {
              void engine.setPassphrase(pass).then((e) => {
                if (e) setErr(e);
                else {
                  setPass('');
                  setErr('');
                }
              });
            }}
            disabled={pass.length < 8}
          >
            <Icon name="lock" /> Derive the key
          </Button>
        </div>
        {err ? <p className="msg-err">{err}</p> : null}
      </Panel>

      <Panel title="Pair with another device" icon="target" note="Commit → challenge → reveal, then an 8-digit code on both screens. An in-room attacker cannot substitute their key without you noticing the digits differ.">
        <div className="kv">
          <span>State</span>
          <b>{c.pairState}{c.role !== 'idle' ? ` · ${c.role}` : ''}</b>
          <span>Shared code to read aloud</span>
          <b className="sas">{c.sas || '—'}</b>
        </div>
        {c.pairState === 'verifying' ? (
          <div className="pair-confirm">
            <p>
              Both devices must show <b>{c.sas}</b>. If a single digit differs, someone is between you.
            </p>
            <div className="row row-btns">
              <Button tone="primary" onClick={() => engine.confirmPairing(true)}>
                <Icon name="check" /> They match
              </Button>
              <Button tone="danger" onClick={() => engine.confirmPairing(false)}>
                <Icon name="x" /> They differ
              </Button>
            </div>
          </div>
        ) : (
          <div className="row row-btns">
            <Button
              onClick={() => {
                void engine.startPairing(true);
              }}
              disabled={c.pairState !== 'idle' && c.pairState !== 'confirmed'}
            >
              <Icon name="send" /> Start (this device speaks first)
            </Button>
            <Button
              onClick={() => {
                void engine.startPairing(false);
              }}
              disabled={c.pairState !== 'idle' && c.pairState !== 'confirmed'}
            >
              <Icon name="mic" /> Wait for the other device
            </Button>
          </div>
        )}
        <p className="muted">
          Run this on two devices a metre apart, on open channel. When the handshake completes both sides derive the same key; from then on every frame is
          sealed and authenticated. Nothing about the key ever touches the wire.
        </p>
      </Panel>

      <Panel title="What this does and does not protect" icon="info">
        <ul className="two-col-list">
          <li>
            <b>Yes</b> — confidentiality and integrity against anyone in earshot, including a device that transmits its own frames as you.
          </li>
          <li>
            <b>Yes</b> — replay protection: a 64-bit window per sender, and a monotonic counter inside the IV, so a recorded frame cannot be useful twice.
          </li>
          <li>
            <b>No</b> — it does not hide that you are communicating. Acoustic links are inherently broadcast; traffic analysis is out of scope.
          </li>
          <li>
            <b>No</b> — no forward secrecy. A passphrase recorded in clear text is a past and future compromise; the pairing mode is the stronger answer.
          </li>
          <li>
            <b>No</b> — the key dies when the tab closes, on purpose. Bring it back by retyping or re-pairing, never by storing it.
          </li>
        </ul>
      </Panel>
    </div>
  );
}
