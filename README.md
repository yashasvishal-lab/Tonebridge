# Tonebridge

**An air-gapped data link that talks through sound.** Two devices, one speaker, one microphone,
no network: Tonebridge modulates your message into real audio, plays it, demodulates it on the
other side, corrects what the room damaged and asks for a retransmission when it cannot.

Everything runs in the browser tab. There is no server, no build-time API key, no font or
script fetched from anywhere, and no request leaves the machine. Turn the radio off, open the
page once, and it still works — including after a reload, because it is a service-worker
cached, installable single-file app.

```
npm install
npm run dev        # http://localhost:3000  (open it on two devices on the same Wi-Fi)
npm run verify     # typecheck + 62 tests + production build
npm run selftest   # the modem's own acceptance run, in Node, no browser
```

---

## What it actually does

| | |
|---|---|
| **Modulation** | Continuous-phase M-ary FSK (4-FSK and 8-FSK), Hann-windowed, integer-bin tones |
| **Profiles** | Standard 250 bps · Robust 200 bps · Sprint 600 bps · Ultrasonic 250 bps · Deep 80 bps |
| **Error control** | Reed-Solomon(255) over GF(2⁸) on the header and the body, driven by *erasure* positions the demodulator derives from tone discrimination; CRC-32 end to end |
| **Diversity** | 12-column block interleaver, synchronous m-sequence scrambler, 9-rate × 5-phase clock search |
| **Link layer** | Addressed and broadcast frames, stop-and-wait ARQ with ≤3 attempts, retransmit-on-lost-ack, 90 s dedupe window, manifest + chunked file transfer with SHA-256 verification |
| **Security** | AES-GCM-256 with the FEC header as AAD, PBKDF2-SHA256 × 250 000, ECDH P-256 commit/reveal pairing with an 8-digit safety number, per-sender replay window, non-extractable keys, explicit `burn()` |
| **Adaptation** | A measured channel sweep picks the profile *and* the FEC strength for the room you are in |
| **Offline** | Service worker, installable, no network access at runtime |

Four panels, every control wired to the engine:

- **Link** — compose and send text or a file, watch the scope, read the transcript, export and
  re-import `.wav`, inspect per-frame confidence.
- **Signal Lab** — the tuner: sweep profile × FEC × channel preset, see delivered/mean-ms/bps for
  every candidate, apply the winner; run a self-test round trip through a chosen room model.
- **Security** — key derivation, pairing, safety-number comparison, sealed frames, replay counters.
- **Settings** — node address, capture source (mic / loopback / simulated channel), output device,
  transmit gain, sample rate, clear transcripts, reset counters.

## Why it works on any device

Most browser modems break on the *sample rate*, not the air. A phone reports 48 000 Hz, a laptop
44 100 or 48 000, a cheap USB headset 16 000 — and a receiver that assumes 44.1 kHz stops working
the moment it does not match.

Tonebridge never fixes a frequency in advance. For the rate the device actually gives it, it picks
a symbol length `L = round(sr · symMs / 1000)` and then **re-quantises every tone to an exact
integer multiple of that device's own DFT bin** (`sr / L`). Tones are therefore orthogonal *on this
machine*, and the receiver's Goertzel-style filter bank needs no resampling and no rate knowledge
at all. A frame's header carries a one-byte `profileTag` derived from `L`, `symMs`, `M` and the
rounded symbol duration, so a receiver configured for 16 kHz will refuse a frame that was rendered
for 48 kHz instead of mis-decoding it.

Three consequences, all deliberate:

1. The same profile works at 16, 32, 44.1, 48 and 96 kHz without a table of variants.
2. Clock error is searched, not assumed: the lock stage tries 9 rate offsets × 5 phase offsets and
   accepts only a candidate whose mean discrimination beats the best rival by 1.1×.
3. Playback and capture use whatever rate the device offers; `planIsPlayable()` refuses profiles
   whose top tone exceeds 0.86 · Nyquist (a 16 kHz mic cannot hear 16.5 kHz, and lying about it
   would just lose frames).

## Air-gapped by construction

The security property people usually mean by "air gap" is *no path to the network*. Tonebridge
takes it literally:

- `index.html` ships a `Content-Security-Policy` of `default-src 'self'`; `script-src 'self'`,
  `base-uri 'none'`, `form-action 'none'`, no `eval`, no `innerHTML`, no remote origin at all.
- No `fetch`/`XMLHttpRequest`/WebSocket in application code — the only `connect-src` allowance is
  the dev-server HMR socket, which does not exist in a production build.
- Keys are `extractable: false` and are never written to storage. Only non-sensitive UI state
  (node address, profile id, transcript) is persisted, in `localStorage`, in the clear, on purpose
  — so you can read exactly what the app keeps.
- Microphone permission is requested only when you pick **Mic** capture. **Loopback** and
  **Simulated** exercise the identical modulator and demodulator with no microphone and no
  permission prompt, which is what makes the test suite possible.
- Transmit gain is clamped to 0.35 with an explicit hearing-protection warning; the ultrasonic
  profile carries its own note, because inaudible energy at high level is still energy.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model, including what this does *not*
protect you from.

## Testing two devices for real

1. Open the app on both. Set **Capture** to *Mic* on both (or *Loopback* on one, to be kind to
   your ears while you check the wiring).
2. Give them different **node addresses** (e.g. 11 and 12). Target `255` is broadcast; a targeted
   frame is ignored by everyone else, without being decoded-and-dropped silently.
3. On one device, run the **tuner** (Signal Lab) for the room you are in and apply the result.
   Both devices should be on the same profile and FEC level — the header would otherwise be
   refused by the `profileTag` check, which is the point.
4. Send text. The receiver's log line should read *decoded … (n errors corrected, m erased)*.
   Then send a file under 256 KiB and compare the SHA-256 that comes back.
5. To prove ARQ rather than luck: partially cover the receiving microphone while the manifest is
   in flight. You should see a retransmission, then a completed transfer — or an honest
   `no acknowledgement received`, never a corrupted message.

## Verification

62 tests, no browser and no network needed (`npm test`):

| file | covers |
|---|---|
| `tests/codec.test.ts` | GF(2⁸) algebra, Reed-Solomon correct/erasure/miscorrect behaviour, CRC-16/32, interleaver round trips, scrambler determinism, WAV quantisation symmetry |
| `tests/modem.test.ts` | plan derivation at 5 sample rates, tone orthogonality and bin exactness, `renderFrame`/`decodeRecording` round trips per profile, channel-model effects, `trace()` confidence behaviour, size-clamping guards |
| `tests/security.test.ts` | key derivation, seal/open with AAD, tamper and wrong-key rejection, IV/counter monotonicity, replay window, pairing state machine (out-of-order and replayed commits), SAS format, `burn()` semantics |
| `tests/engine.test.ts` | the whole link: text delivery, multi-part reassembly, duplicate suppression, echo accounting, targeted-vs-broadcast, file transfer with digest, sealed WAV export/import, `roundTrip`, `runAdapt`, receiver state, size guards, counter resets |

`npm run selftest` is the modem's own acceptance gate: N single-shot frames per profile on the
three rooms every device must handle, then a tuner sweep that must find a 100 %-delivery
configuration in all five room models. Measured acceptance, `npm run selftest -- --n 8`, four-digit honesty included: at 40-byte payloads every
profile delivers 8/8 on the three baseline rooms at Balanced FEC (111 / 89 / 247 / 111 / 36 delivered
bytes/s for Standard / Robust / Sprint / Ultrasonic / Deep, 18–51 ms of demodulation per frame), and
the tuner finds a 100 %-delivery configuration in all five room models. At the *largest legal frame*
the picture is worse and that is worth knowing: `npm run cli -- matrix --n 6` shows five cells where
standard 8 ms / 10 ms profiles lose frames across a reverberant room, and `--fec max` makes them
worse, not better. The full tables, and what to conclude from them, are in
[docs/MEASUREMENTS.md](docs/MEASUREMENTS.md).

## Command line

The core is DOM-free, so it is also a CLI — same modules as the UI, no second implementation to keep
in sync:

```
npm run cli -- encode --text "meet at the gate" --profile robust --fec heavy --out gate.wav
npm run cli -- decode gate.wav --profile robust --fec heavy
npm run cli -- bench  --profile sprint --channel cafe
npm run cli -- matrix --n 6 --fec balanced     # profile × room delivery table
npm run cli -- selftest --n 8                  # the acceptance gate, exit code 1 on any failure
npm run cli -- profiles
```

`decode` needs the same `--profile` and `--fec` you encoded with: a frame does not self-describe its
parity length, and guessing would mean quietly mis-decoding instead of reporting that nothing
matched. The web app keeps both ends configured together, which is why it has no such rule.

## Documentation

- [docs/PROTOCOL.md](docs/PROTOCOL.md) — the wire format: plan derivation, header layout, FEC and
  interleaving, sync/lock thresholds, envelopes, ARQ rules, the WAV container.
- [docs/SECURITY.md](docs/SECURITY.md) — threat model, key derivation, what the AEAD tag binds,
  nonce discipline, replay window, pairing, and an explicit list of what is *not* protected.
- [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md) — the tables in §Verification, including where the
  modem loses frames and why more FEC is the wrong medicine.

## Layout

```
src/core/   the modem, no DOM: profiles, plan derivation, framing, RS/GF(256), interleaver,
            DSP, transmit render, receive demodulator, channel models, WAV container, adaptation
src/link/   the conversation around it: audio graph, envelopes, crypto, engine (state + store)
src/ui/     React panels; every control calls an engine method
src/worklets → public/capture-worklet.js  real-time capture, kept out of the bundle on purpose
tools/      CLI, icon generator
tests/      vitest, node environment
docs/       PROTOCOL.md, SECURITY.md, MEASUREMENTS.md
```

## Known limits (stated plainly)

- **Throughput is what physics allows.** ~90–280 delivered bytes/s at voice-band rates. A 100 KB
  file is a slow-but-finished transfer, not a fast one. The 256 KiB cap exists so nobody starts a
  nine-minute transmission by accident; raise `FILE_LIMIT` if you want the pain.
- **Echo and a moving phone are the enemies**, not noise alone. The tuner exists because a laptop
  on a desk and a phone in a hand are different channels; run it again when the room changes.
- **Half-duplex by design.** Send, hear the ack, send the next frame. Simultaneous transmission
  from both ends is what the retries are for, not something to aim at.
- **No forward secrecy between pairings** and no deniability; the passphrase path is a KDF, so a
  weak passphrase is weak. The pairing path is ECDH, and the safety number is there for you to
  actually read aloud.

MIT licensed. See [LICENSE](LICENSE).
