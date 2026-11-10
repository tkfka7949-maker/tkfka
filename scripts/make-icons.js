// 앱 아이콘 PNG 만들기:  node scripts/make-icons.js
// 아이폰 홈 화면은 SVG 아이콘을 못 쓰기 때문에 PNG가 필요해요. 외부 라이브러리 없이 직접 그립니다.
// 모양: 밤하늘 바탕 + 초승달 + 소리 막대 3개 (icon.svg 와 같은 도형, 64칸 좌표)
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BG = [0x0c, 0x12, 0x20];
const MOON = [0xf0, 0xb4, 0x5a];
const BAR_ALPHA = 0.55;
const OUTER = { x: 36, y: 28, r: 17 };
const CUT = { x: 43, y: 21, r: 13.5 };
const BARS = [[16, 47, 16, 53], [22, 43, 22, 56], [28, 47, 28, 53]];
const BAR_HALF = 1.6;

const inCircle = (px, py, c) => (px - c.x) ** 2 + (py - c.y) ** 2 <= c.r ** 2;
function segDist(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function render(size) {
  const ss = 4; // 4x4 슈퍼샘플링으로 가장자리를 부드럽게
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let moon = 0, bar = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = ((x + (sx + 0.5) / ss) / size) * 64;
          const v = ((y + (sy + 0.5) / ss) / size) * 64;
          if (inCircle(u, v, OUTER) && !inCircle(u, v, CUT)) moon++;
          else if (BARS.some((b) => segDist(u, v, b) <= BAR_HALF)) bar++;
        }
      }
      const n = ss * ss;
      const mA = moon / n, bA = (bar / n) * BAR_ALPHA;
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        let val = BG[c];
        val = val * (1 - bA) + MOON[c] * bA;
        val = val * (1 - mA) + MOON[c] * mA;
        px[i + c] = Math.round(val);
      }
      px[i + 3] = 255; // 아이폰 아이콘은 투명 배경을 쓰면 안 됨
    }
  }
  return encodePng(size, size, px);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = fileURLToPath(new URL('../icons/', import.meta.url));
mkdirSync(outDir, { recursive: true });
for (const size of [180, 192, 512]) {
  writeFileSync(`${outDir}icon-${size}.png`, render(size));
  console.log(`icons/icon-${size}.png`);
}
