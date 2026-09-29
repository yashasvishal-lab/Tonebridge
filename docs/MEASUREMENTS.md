# Measurements

Everything in this file was produced by the commands shown, on this machine, at
`sr = 48 000 Hz`, `--n` frames per cell, single shot (no retransmission) unless stated. Reproduce
with `npm run cli -- matrix …` and `npm run selftest -- …`; the models are deterministic
(`mulberry32` seeded per candidate), so the numbers are stable to within the bps rounding.

Two axes matter and both are published: the **room** (channel model) and the **payload size**.
A modem that looks perfect at 40-byte frames and falls apart at 223-byte frames is not a good
modem, it is a good demo — and a 200-byte chunk is what file transfer actually puts on the air.

## 1. Raw delivery: every profile × every room, Balanced FEC, largest legal frame

`npm run cli -- matrix --n 6`

| profile | Bench | Quiet room | Loud cafe | Across the room | Cheap phone |
|---|---|---|---|---|---|
| Standard (4-FSK, 8 ms) | 6/6 · 204 bps | 6/6 · 204 | 6/6 · 204 | **1/6** | 6/6 · 204 |
| Robust (4-FSK, 10 ms) | 6/6 · 163 | 6/6 · 163 | 6/6 · 163 | **0/6** | 6/6 · 163 |
| Sprint (8-FSK, 5 ms) | 6/6 · 476 | 6/6 · 476 | 6/6 · 476 | **0/6** | 6/6 · 476 |
| Ultrasonic (4-FSK, 8 ms) | 6/6 · 203 | 6/6 · 203 | **0/6** | **3/6** | 6/6 · 203 |
| Deep (4-FSK, 25 ms) | 6/6 · 42 | 6/6 · 42 | 6/6 · 42 | 6/6 · 42 | 6/6 · 42 |

`bps` is delivered user bytes per second of air for a clean run; a cell with losses has no rate
quoted, because the lost frames are not free.

Read it as: fast narrowband profiles die in the two rooms where the channel changes *during* a
long frame (echo spread across the room; café babble modulating the noise floor), and the profile
nobody likes on paper — 25 ms symbols, 42 bps — is the only one that never blinked.

## 2. The wrong answer: more parity

`npm run cli -- matrix --n 6 --fec max` (48 body parity bytes instead of 16)

| profile | Across the room | Loud cafe (ultrasonic) | cost on a clean run |
|---|---|---|---|
| Standard | 0/6 (was 1/6) | — | 204 → 177 bps |
| Robust | 0/6 | — | 163 → 140 |
| Sprint | 0/6 (was 0/6) | — | 476 → 416 |
| Ultrasonic | 0/6 (was 3/6) | 0/6 | 203 → 177 |
| Deep | 6/6 | 6/6 | 42 → 20 |

Stronger FEC **loses more frames** in exactly the cells it was supposed to rescue. The reason is
structural, not a bug: parity bytes lengthen the frame, and the failure mode in those rooms is
decorrelation *inside* one frame. A longer frame is a wider window for the channel to move under
the interleaver. Erasure-driven Reed-Solomon cannot fix a symbol whose tone moved to a neighbouring
tone; it can only fill holes it was told about.

This is why the tuner searches profiles as well as FEC levels, and why "just raise the FEC" is not
a control the app offers as a fix.

## 3. What the tuner does instead (the shipped behaviour)

`npm run selftest -- --n 6 --payload 200` — 20 candidates (5 profiles × 4 FEC levels), the winner
must deliver every frame or it is not chosen:

| room | chosen configuration | result |
|---|---|---|
| Bench | Sprint + Light FEC | 6/6 · 486 bps · 44 ms/frame RX |
| Quiet room | Sprint + Light FEC | 6/6 · 486 · 51 |
| Loud cafe | Sprint + Light FEC | 6/6 · 486 · 46 |
| **Across the room** | **Deep + Light FEC** | **6/6 · 53 bps · 71** |
| Cheap phone speaker | Sprint + Light FEC | 6/6 · 486 · 45 |

Same run at the short-payload default (`npm run selftest -- --n 8`, 40 B frames):

```
case                              result      bps    rx ms     detail
Standard / Bench                  8/8         111    27.6      baseline, no retries
Standard / Quiet room             8/8         111    23.9      baseline, no retries
Standard / Cheap phone speaker    8/8         111    22.3      baseline, no retries
Robust   / …                      8/8         89     24-25     baseline, no retries
Sprint   / …                      8/8         247    20-22     baseline, no retries
Ultrasonic / …                    8/8         111    21        baseline, no retries
Deep     / …                      8/8         36     45-48     baseline, no retries
tune: Bench                       8/8         276    18.6      Sprint + Light FEC, 20 candidates
tune: Quiet room                  8/8         276    20.6      Sprint + Light FEC
tune: Loud cafe                   8/8         276    21.5      Sprint + Light FEC
tune: Across the room             8/8         205    24.9      Sprint + Heavy FEC
tune: Cheap phone speaker         8/8         276    20.1      Sprint + Light FEC

20 checks passed
Exit 0.
```

The gate is not "the best average" — it is *100 % delivery, then maximum bps*. That is the correct
optimisation for a link whose retransmission is a whole extra frame of airtime: a 95 % configuration
that needs 5 % of frames resent is strictly worse than a 100 % one at two thirds the rate.

Note that at 40 B the tuner is happy to stay on Sprint with Heavy FEC across the room (205 bps), while
at 200 B it abandons Sprint for Deep (53 bps). Short frames survive echo; long ones do not. Both are
measured, neither is a rule in the code.

## 4. Single-shot behaviour, no tuning, at each profile's own defaults

`npm run selftest -- --n 8` (Balanced FEC, 40 B payload) — every profile delivers 8/8 in all three
baseline rooms; the delivered rate spans 36–247 bps with 18–51 ms of demodulation per frame. The
baseline rooms are the ones a normal device must handle without help: `bench` (direct digital
path), `quiet` (a real room, low noise), `phone` (band-limited speaker/mic, 300–3 400 Hz).

## 5. Cost accounting, so the bps figures are interpretable

Per frame, Standard at 48 kHz: 31 preamble symbols + 3 padding + 112 header symbols +
body symbols, at 8 ms each, plus 30 ms lead and 24 ms tail. A 40-byte payload therefore costs
about 1.30 s of air to deliver 40 bytes → 30.8 bytes/s raw = 246 bps of *user* bits, against a
physical 250 bps symbol rate for 4-FSK at 8 ms. The gap between "250 bps 4-FSK" and the
delivered 111–204 bps in the tables is FEC parity, CRC, the header, the interleaver tail, and the
lead/tail — all of it measured rather than asserted.

Throughput of the *software*, as opposed to the air interface, is irrelevant to a user but worth
recording because it decides whether a phone can decode in real time:

`npm run cli -- bench --profile standard` → about **27× real time** on one core of this machine
(render + channel model + full receive), and `--profile sprint` is faster per byte still. Every
profile decodes comfortably faster than real time, which is the requirement for a 16 kHz phone.

## 6. Where the numbers came from, and what they are not

- The channel models in `src/core/channel.ts` are *physical* approximations — filtered noise with a
  band profile, a multipath echo train with per-tap decay, gain ramps, a babble-like
  modulation on the floor, and a small sample-rate skew — not a replay of your room. A real room
  with a glass table and a fan will differ; the tuner is what makes the app cope with that, and
  running it after you change the physical setup is the intended workflow.
- "Bench" is the digital loopback: the same modulator, the same demodulator, no air. It exists so
  a failing `bench` cell can only mean a code bug, and so CI needs no microphone permission.
- Nothing here is a claim about the ultrasonic profile on hardware that cannot reproduce 16 kHz.
  `planIsPlayable()` is the guard; a laptop whose tweeters roll off at 15 kHz will lose frames in a
  way no amount of FEC (see §2) will repair.
