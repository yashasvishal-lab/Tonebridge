# TBP-1 — Tonebridge Protocol, frame 1

Version byte `1`. Everything below is what the code in `src/core` does; nothing here is aspirational.

```
[ lead 30 ms ][ preamble 31 sym ][ pad 3-6 sym ][ header 12 B + FEC ][ body payload + FEC ][ tail 24 ms ]
```

## 1. Air interface

A plan is derived per device, from the sample rate the device actually reports:

| quantity | rule |
|---|---|
| symbols per second | `L = clamp(round(sr · symMs / 1000), ≥ 8, ≤ sr / 8)` samples per symbol |
| tone frequencies | each nominal tone snapped to `round(f / bin) · bin`, `bin = sr / L` |
| modulation | `M = tones.length`, `bitsPerSymbol = log2 M`, continuous phase, Hann-shaped `rampMs` edges |
| resolution of the scan | `subStep = max(1, round(L / subDiv))` samples between timing candidates |
| `profileTag` | `crc16([L, L>>8, round(symMs·10), M]) & 0xff` — one byte that fingerprints the timing |

Requiring `f = k · sr / L` makes every tone complete an integer number of cycles inside one
symbol, so the per-tone DFT is exactly orthogonal on *this* device, at *this* rate, with no
resampling and no windowing leakage between tones. That single constraint is what removes the
class of "works at 44.1 kHz, dies at 48 kHz" bugs, and it is why `profileTag` can be a byte: it is
a hash of the timing a receiver would need in order to agree with the sender.

`planIsPlayable(plan)` is false when the top tone exceeds `0.86 · sr / 2`; such a profile cannot be
heard by that device and must not be offered.

## 2. Header — 12 bytes, always

Offset | bytes | meaning
---|---|---
0 | 1 | protocol version (1)
1 | 1 | flags
2 | 1 | `profileTag` — receiver refuses a frame whose timing fingerprint differs
3 | 1 | sender node address
4 | 1 | target node address (`0xff` = broadcast)
5 | 1 | message id
6 | 1 | chunk index within the message (`& 0xff`)
7 | 1 | chunk count
8 | 2 | body length, big endian
10 | 2 | CRC-16 (CCITT-FALSE) over bytes 0…9

Flags: `ENCRYPTED 0x01 · WANTS_ACK 0x02 · FILE 0x04 · MANIFEST 0x08 · ACK 0x10 · NACK 0x20 · CTRL 0x40 · BEACON 0x80`.

The CRC-16 is checked *before* the RS decode is trusted, and `bodyLen` is validated against the
plan's `maxBody` in the same step. An unknown version, a foreign `profileTag`, a zero or oversized
body, or a bad CRC means the header is dropped: never "best effort" parsed.

Header and body are separately encoded, separately interleaved and separately RS-protected, so a
short ACK only needs the header FEC to survive. That asymmetry is deliberate: control traffic must
work in rooms where a 223-byte payload does not.

## 3. Body codeword

```
crc32(payload) || payload || RS parity            →  interleave (12 columns)  →  scramble  →  symbols
```

- CRC-32 is placed *ahead* of the payload so it is spread across the whole codeword by the
  interleaver rather than clustered at one end.
- Reed-Solomon over GF(2⁸), generator built from a square Vandermonde matrix inverted by
  Gauss-Jordan at construction (`src/core/rs.ts`, parity 2…64). Decoding accepts an explicit
  **erasure** list; correction of unknown errors is the fallback, not the plan.
- The interleaver is a 12-column block permutation, so one 40 ms burst of noise is scattered over
  12 different codeword positions instead of deleting a run of bytes.
- Scrambling is a synchronous additive stream cipher seeded from `crc16(profileTag, msgId, chunkIdx)`.
  It is not encryption; it removes long runs of equal symbols (which would be a spectral line, and
  an unfair gift to a false sync), and it makes the symbol stream independent of payload content.

`maxBody` is clamped in `makePlan` so that preamble + header + body always fits inside the
receiver's window at the current device rate: `RX_WINDOW_SEC = 12` s of held audio
(additionally capped at 32 MB, so a 96 kHz device cannot be made to allocate unbounded memory).
A sender that asks for more gets a smaller frame, not a frame the receiver will refuse later.

## 4. Erasure metrics, and why confidence gates FEC

The coarse pass computes, per symbol and per timing candidate, the winning tone index plus a
discrimination ratio `rel` (winner over runner-up power). Two rules use it:

1. `rel < ERASURE_REL (2.2)` → the symbols of that tone position are declared **erasure candidates**.
2. After the inverse permutation, candidates are ranked by worst `rel`, capped at `bodyParity`, and
   handed to Reed-Solomon as erasures. Erasures cost half as much correction capacity as errors, so
   telling the codec *where* the room hurt is worth roughly a doubling of burst tolerance — this is
   the single biggest reason the low-rate profiles hold 100 % where naive MFSK does not.

A frame whose mean discrimination is below `MIN_FRAME_CONF (1.35)` is not offered to FEC at all.
Weakening that gate produces *plausible* garbage: a CRC would catch it, but the log would fill with
frames that decoded and then failed, and the eye chart on the Link panel would lie about the room.

## 5. Sync and lock

- The preamble is a 31-chip maximum-length sequence (degree-5 LFSR, `x⁵ + x² + 1`) mapped to the
  extreme symbols (`0` and `M-1`). Its periodic autocorrelation is `-1/31`, so a false lock on room
  noise is on the order of one in a billion candidate slots; the padding symbols after it exist so
  a rate error cannot push the header into the tail of the sequence.
- A candidate becomes a lock candidate only if `hits ≥ max(11, ceil(0.70 · 31))` **and** the mean
  discrimination over the sequence exceeds `1.2×`. The second test is what keeps an accidental
  run of similar symbols from costing a 9-rate × 5-phase header sweep.
- Lock then searches `RATE_SEARCH = [1, ±0.09 %, ±0.045 %, ±0.18 %, ±0.32 %]` × `PHASE_SEARCH =
  [0, ±1, ±2]` symbols and accepts a candidate only if its mean discrimination beats the current
  best by 1.1×. Clock skew up to ±0.32 % is normal for consumer audio (and is why the receiver's
  bookkeeping advances `scan` by `frame length × RATE_MAX`: it never re-reads a region it just used).
- `deadline = now + frame length + 2 s`: a frame whose tail never arrives is abandoned, not held.
- Frames arrive from a live stream, so one `push()` may contain several whole frames; the drain loop
  processes up to 64 of them per push (32 candidates each) before yielding, otherwise a burst-fed
  receiver would decode one frame per push and look like it was dropping the rest.

## 6. Envelopes (inside the body)

Addressing, sequencing and chunk indices are already in the FEC-protected header, so the envelope
carries only what the header has no room for. All multi-byte integers are big endian.

| kind | payload |
|---|---|
| 1 TEXT | `u16 length` · UTF-8 bytes |
| 2 MANIFEST | `u8 nameLen` · name · `u8 mimeLen` · mime · `u32 size` · `u16 chunks` · `u16 chunkSize` · 32 B SHA-256 |
| 3 CHUNK | `u16 index` · bytes |
| 4/5 ACK / NACK | `u8 msgId` · `u16 chunkIdx` |
| 6 CTRL | `u8 sub` · bytes — `1 HELLO · 2 BYE · 3 PAIR_COMMIT · 4 PAIR_CHALLENGE · 5 PAIR_REVEAL · 6 PING` |

## 7. Framing above the modem

The bytes above become the modem payload through one fixed 2-byte prefix, which is the only
unencrypted metadata on the wire:

```
[0] = 1 if this frame is sealed with a key, 0 if it is in the clear
[1] = 0 (reserved)
then: ciphertext = 12 B IV || AES-GCM(ct, 16 B tag)   (sealed)
      payload                                            (open)
```

Framing is 2 bytes in the clear, sealed frames add 26 more (IV + tag): `crypto.overhead` is `30`
with a key and `2` without. A keyed receiver rejects open frames and an open receiver rejects
sealed ones — counted in `stats.framesRejected`, never silently delivered as garbage.

Chunk payloads for both files and long messages carry a 2-byte transfer id prefix
(`transferId` big endian) inside the CHUNK envelope, so interleaved transfers do not merge.

## 8. Link behaviour

- **Stop-and-wait per frame.** `WANTS_ACK` is set on every data frame; the timeout is
  `frame airtime × 1.15 + 2 500 ms`, armed *before* the waveform is handed to the audio graph (arming
  after means a fast peer's ACK lands before anyone is listening, which on a loopback device
  reproduced as 9 s of pointless retries).
- ≤3 attempts, then an honest failure to the UI (`no acknowledgement received`). Retries reuse the
  `msgId`/`chunkIdx`, so an ACK that arrives late — while the sender is already retransmitting — still
  settles the wait: late ACKs are parked in `lateAcks` and consumed by the next `armAck`.
- **Duplicates are re-acked, not re-delivered**, keyed `sender:msgId:chunkIdx` for 90 s. The lost
  thing in a real exchange is more often the acknowledgement than the data.
- **A targeted frame is dropped after the header**, before body demodulation, so a busy room does not
  make every device pay full receive cost for traffic that is not its own.
- Manifests get their own `msgId` with `chunkIdx = 255`; data chunks get a fresh `msgId` each. A
  *retransmitted* manifest is answered with an ACK rather than silently ignored, otherwise the sender
  retries three times and gives up while the receiver already has the file plan.
- Local echo is suppressed when a caller has wired the transmitter to another receiver
  (`engine.onEmit`), because a device should not have to disentangle its own frame from a peer's
  answer in one sample stream.
- File cap 256 KiB per transfer, enforced before transmission, and the receiver refuses a manifest
  claiming more than 8× that.

## 9. WAV container

`src/core/wav.ts` writes canonical 16-bit PCM (44-byte header, no LIST/INFO chunks, no floating
point extension) and quantises symmetrically — `round(v · 32768)` clamped to ±32768, read back as
`/ 32768`. An asymmetric quantiser (`· 32767` out, `/ 32768` in) shifts every sample by a fraction
of an LSB, which is harmless for audio and not harmless for a modem that measures tone power
ratios near its decision thresholds. Exported `.wav` files are decodable by `npm run cli -- decode`,
by the Link panel's file drop, and by any editor you want to inspect them in.
