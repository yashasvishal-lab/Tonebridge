# Security

Tonebridge's security goal is narrow and stated up front: **a message sent between two devices that
can hear each other must not be readable or forgeable by a third device in earshot, and neither
device may be led to believe the other said something it did not.** Everything below serves that.
It is not an anonymity system, not a transport for secrets at rest, and not a substitute for a
network security layer.

Verified by `tests/security.test.ts` (12 tests) and the sealed-path tests in `tests/engine.test.ts`
(14 tests). No cryptographic primitive is hand-rolled: AES-GCM, ECDH, HKDF, PBKDF2, SHA-256 and the
Web Crypto random source are the browser's own, reached through `crypto.subtle`.

## 1. Two ways to get a key

**(a) Passphrase.** `PBKDF2-SHA256`, 250 000 iterations, salt
`SHA-256("tonebridge/psk/1" ‖ passphrase)`, output an AES-GCM-256 key marked
`extractable: false`. The passphrase is normalised NFKC and UTF-8 encoded before `importKey`
(browsers disagree on coercing a `USVString` into `importKey('raw', …)`, and silently disagreeing
here is how two devices end up with different keys from the same password). Minimum length 8,
enforced with a message that says why rather than a number.

The label in the salt means a Tonebridge key derived from `hunter2` is not the same bytes as some
other tool's key from `hunter2`. Reuse across tools is not made safe, but it is made *unrelated*.

**(b) Pairing.** Ephemeral `ECDH P-256` on both devices, exchanged through a
commit → challenge → reveal sequence, then `HKDF-SHA256(shared, salt = SHA-256(label ‖ the two
commitments in sorted order), info = "tonebridge/aead/1")` → AES-GCM-256, non-extractable.

The commit/reveal order is what makes pairing safe against the attacker-in-the-room model:
neither side can see the other's public key and then choose its own to steer the resulting key, so
there is no value to force and no way to make a chosen ciphertext decrypt to something the peer will
trust. Each step is answered by an explicit ACK frame, and the state machine is strict: a `COMMIT`
is only honoured while idle, a `CHALLENGE` only after a commitment was sent, a `REVEAL` only while
challenged. Replayed or out-of-order messages are dropped rather than "resynchronised", and a
commitment that does not hash to the revealed key material ends the attempt.

**Safety number.** Both sides derive an 8-digit SAS from `SHA-256("tonebridge/sas/1" ‖ both public
keys ‖ the derived key)`, displayed as `1234 5678`, and shown *only* as a pair to be read aloud to
each other. The session is not marked `secure` until a human confirms it
(`keyConfirmed`). This is the one step that cannot be automated: without it, an active attacker who
can carry all the audio between the two devices can pair with each of them separately.

## 2. What is encrypted, and what is authenticated

A frame body on the wire is

```
[sealed? 1 B][reserved 1 B] ( [12 B IV] ‖ AES-GCM(payload, tag 16 B) ‖ )[sealed]
                            ( payload                                ‖ )[open]
```

`AES-GCM` is given **the 12-byte FEC frame header as additional authenticated data**
(`aad = packHeader(plan, header)`). Consequences:

- The ciphertext is bound to *its own* addressing: sender, target, `msgId`, `chunkIdx`, chunk count,
  body length and flags. An attacker in the room cannot take a valid sealed body from one frame and
  re-point it at another node, reorder chunks, or trim a length field to truncate — the tag fails.
- Editing the header to make the receiver use *more* FEC, or a different `profileTag`, also fails:
  the header is part of what the tag covers.
- Flipping the `sealed?` framing byte is caught both ways: a keyed receiver refuses frames marked
  open, an open receiver refuses frames marked sealed. Both are counted in `stats.framesRejected`
  and logged; nothing is delivered as "probably fine".

The 2-byte framing prefix and the header (as AAD) are **confidentiality-protected but not hidden**:
who is talking to whom, at what address, how big the message is, and how many chunks it took are
all visible to anyone in the room, and so is the fact that a transmission happened. That is the
cost of a receiver needing to know how to decode; it is stated here rather than glossed over.

## 3. Nonces and replay

IV = `u32 random session epoch ‖ u64 monotonic transmit counter`. GCM's failure mode is IV reuse
under one key, so it is made structurally impossible rather than merely unlikely:

- the counter increments per seal and never decreases;
- a new key, `burn()`, or a re-derived passphrase resets the counter *and* draws a fresh random
  epoch, so two sessions of the same key are separated in the 32-bit space rather than restarted
  on top of each other;
- the epoch is `|| 1`-guarded because 0 is the value a crashed process leaves behind.

Receiving keeps a per-sender `{epoch, highest, bitmap of 64}` window. A frame ahead of the window
advances it; one inside it is accepted once and marked; one older than 64 back is counted in
`crypto.replaysDropped` and discarded. What this buys is specific: **a recording of a past
transmission cannot be replayed for effect** — not a re-sent file, not a replayed "transfer approved"
command, not an old acknowledgement that would complete a transfer the sender already gave up on.
What it does not buy: an attacker cannot be *prevented* from playing your own old audio at your
device, and the frame will be correctly identified as old. The link refuses to deliver it; it
cannot make the room quiet.

## 4. Key material lifecycle

- Keys live in `CryptoKey` objects with `extractable: false`. There is no code path that can read
  the bytes out, and none that tries: no JWK export, no `extractKey`, no serialisation.
- **Nothing cryptographic touches storage.** `src/link/storage.ts` persists node address, profile and
  FEC ids, channel presets and transmit gain; message contents are stored only if you turn
  transcript saving on. Never a passphrase, never a key, never pairing state.
- `burn()` clears key, ECDH pair, commitments, SAS, confirm flag, replay state and the mode (back
  to `open`), and says so in the log. There is no "temporarily disabled" state that would leave a
  key in memory while pretending otherwise.
- A reload loses the key by construction. Re-pairing takes seconds; that asymmetry is deliberate —
  the expensive thing should be recovery, not protection.
- The derived key is held on the engine object, reachable only through methods. `globalThis.__tonebridge`
  exists for tests and console debugging; it exposes the store and the API, never key material.

## 5. Fail-closed rules in the engine

Each of these was a bug in some modem I read about while writing this one; they are here because
"works unless something is wrong" is not a security property.

- A sealed frame whose tag does not verify is dropped, counted in `stats.framesRejected` and
  logged. It is deliberately **not** NACKed: an unauthenticated frame must not be able to make this
  device transmit, and the sender's own ARQ timeout is a sufficient recovery path.
- A manifest larger than 8× the file cap, a chunk index the manifest did not promise, a digest
  mismatch at completion: the transfer is marked failed with a specific reason, not truncated and
  not silently completed.
- Unknown envelope kinds, unknown CTRL subtypes, unknown protocol versions: dropped.
- A frame addressed to another node is dropped after header decode and *before* body demodulation,
  so a device cannot be CPU-denied by a stream of traffic aimed at someone else.
- `pairState` and `mode` are published to the UI synchronously with the crypto state change, so the
  padlock you see is the state you get — no optimistic "secure" badge while derivation is still
  running.
- `crypto.secure` is false until a human confirms the safety number, and every transcript entry
  records whether the channel was sealed at the time, so "was this protected" stays answerable
  after the fact instead of being a badge that only reflects the current setting.

## 6. Browser surface

- `Content-Security-Policy` (meta, first thing in `<head>`): `default-src 'self'`,
  `script-src 'self'`, `worker-src 'self' blob:`, `connect-src 'self' ws:` (dev-server HMR only;
  absent from a production build), `img/media-src 'self' data: blob:`, `base-uri 'none'`,
  `form-action 'none'`, `frame-ancestors 'self'`, `style-src 'self' 'unsafe-inline'` — the last one
  for per-element canvas layout, the only inline style the app writes, and never from user input.
  No `eval`, no `new Function`, no `innerHTML`, no remote origin of any kind.
- Microphone is requested on an explicit user choice, never on load; `getUserMedia` is
  `{ echoCancellation: false, noiseSuppression: false, autoGainControl: false }`, because those
  "improvements" are adaptive filters that eat modulation.
- Playback goes through one `AudioContext` that is created inside a gesture and closed on teardown;
  the capture worklet posts transferable buffers and never holds a reference.
- The service worker (`public/sw.js`) caches same-origin GETs only, never proxies another origin,
  and stores no response produced after a message was sent — i.e. nothing that could turn a
  transmission into a retrievable artifact for a later visitor.
- Transmit gain is clamped to 0.35 and the ultrasonic profile carries an explicit warning:
  inaudible does not mean harmless.

## 7. Honest limits

- **Side channel.** Length, timing, count and addresses are in the clear. An observer with a
  microphone learns *that* and *how much*, not *what*.
- **Passphrase strength.** 250 000 PBKDF2 iterations slow a GPU to roughly a million guesses per
  second per card per key; a four-word passphrase is not a place to put something you would mind
  losing. The pairing path has no such weakness and takes 20 seconds.
- **No forward secrecy after the fact for the PSK path:** a later passphrase compromise decrypts
  recorded sealed traffic. ECDH pairing is ephemeral and does give it; keys are not stored anywhere,
  so there is nothing to take off a running machine other than RAM.
- **No deniability, no ratcheting, no post-compromise rotation within a session.** The counter
  resets per session; a compromised device can forge to its peer. There is no trust-on-first-use
  pinning to warn you a peer changed keys — the SAS comparison *is* the TOFU, and only as good as
  the two humans who read it.
- **A malicious page in the same origin** could read the transcript in `localStorage`. If the
  machine is hostile, an acoustic modem is not the layer that saves you.
- Timing and channel state leak through what a frame *costs*: an observer who can see your retransmit
  pattern learns something about the room and the loss rate.
