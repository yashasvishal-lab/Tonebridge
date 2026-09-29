/**
 * Rasterises the app icon with no dependencies: draws into an RGBA buffer, then writes
 * a PNG by hand (zlib deflate + CRC-32). Needed because a PWA must ship real PNGs at
 * 192 and 512 px, and the rest of the project deliberately has no image toolchain.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const BG: [number, number, number] = [14, 24, 35];
const A: [number, number, number] = [86, 224, 200];
const B: [number, number, number] = [127, 214, 255];

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function px(x: number, y: number, s: number, r: number): number {
  // rounded-square coverage
  const hx = s / 2 - r;
  const hy = s / 2 - r;
  const dx = Math.max(Math.abs(x - s / 2) - hx, 0);
  const dy = Math.max(Math.abs(y - s / 2) - hy, 0);
  return Math.sqrt(dx * dx + dy * dy) <= r ? 1 : 0;
}

function distToPath(x: number, y: number, s: number): number {
  // the same three-hump wave as icon.svg, sampled
  const u = (x / s) * 4;
  const seg = Math.floor(u);
  const f = u - seg;
  const cyc = [0, 1, 0, 1][((seg % 4) + 4) % 4]!;
  const yy = 0.62 - (cyc === 0 ? 1 : -1) * 0.42 * Math.sin(Math.PI * f);
  return Math.abs(y / s - yy) * s;
}

function render(size: number): Buffer {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.21;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const cov = px(x, y, size, r);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      if (!cov) continue;
      let [cr, cg, cb] = BG;
      const g = (x + y) / (2 * size);
      cr = Math.round(cr + 8 * g);
      cg = Math.round(cg + 12 * g);
      cb = Math.round(cb + 18 * g);
      const d = distToPath(x, y, size);
      const w = size * 0.05;
      if (d < w) {
        const t = Math.min(1, (w - d) / w) * (1 - Math.abs(x / size - 0.5) * 0.15);
        const ar = A[0]! * (1 - g) + B[0]! * g;
        const ag = A[1]! * (1 - g) + B[1]! * g;
        const ab = A[2]! * (1 - g) + B[2]! * g;
        cr = Math.round(cr + (ar - cr) * t);
        cg = Math.round(cg + (ag - cg) * t);
        cb = Math.round(cb + (ab - cb) * t);
      }
      for (const cx of [0.2, 0.5, 0.8]) {
        const dd = Math.hypot(x - cx * size, y - 0.775 * size);
        if (dd < size * 0.035) {
          const t = Math.min(1, (size * 0.035 - dd) / (size * 0.012));
          cr = Math.round(cr + (A[0]! - cr) * t);
          cg = Math.round(cg + (A[1]! - cg) * t);
          cb = Math.round(cb + (A[2]! - cb) * t);
        }
      }
      raw[o] = cr;
      raw[o + 1] = cg;
      raw[o + 2] = cb;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const buf = render(size);
  writeFileSync(`public/icon-${size}.png`, buf);
  console.log(`public/icon-${size}.png  ${(buf.length / 1024).toFixed(1)} kB`);
}
