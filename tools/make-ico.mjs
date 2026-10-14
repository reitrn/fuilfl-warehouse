// Assemble a proper Windows .ico from PNG frames (PNG-in-ICO, full 8-bit alpha — no jagged 1-bit mask like
// Icon.FromHandle produces). Usage: node tools/make-ico.mjs out.ico frame16.png frame32.png ... (any sizes ≤ 256).
import { readFileSync, writeFileSync } from 'node:fs';
const [out, ...frames] = process.argv.slice(2);
if (!out || !frames.length) { console.error('usage: make-ico.mjs out.ico a.png b.png …'); process.exit(1); }
const pngs = frames.map(f => readFileSync(f));
const size = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });   // IHDR
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
const dir = Buffer.alloc(16 * pngs.length);
let offset = 6 + dir.length;
pngs.forEach((p, i) => {
  const { w, h } = size(p); const o = i * 16;
  dir.writeUInt8(w >= 256 ? 0 : w, o); dir.writeUInt8(h >= 256 ? 0 : h, o + 1); dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(p.length, o + 8); dir.writeUInt32LE(offset, o + 12);
  offset += p.length;
});
writeFileSync(out, Buffer.concat([header, dir, ...pngs]));
console.log(`${out}: ${pngs.length} frames (${frames.map(f => size(readFileSync(f)).w).join(', ')} px)`);
