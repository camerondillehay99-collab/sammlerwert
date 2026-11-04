/**
 * Minimal QR code encoder (byte mode, error correction level M, versions 1–10, ≤ 213 bytes).
 * Used for the 2FA otpauth:// link and the "open on your phone" code on desktop. No dependencies.
 * Follows ISO/IEC 18004: data codewords → Reed-Solomon blocks → interleave → module placement → mask with lowest penalty.
 */

const EC_M: Array<[number, number, number, number]> = [ // version → [ecPerBlock, blocks1, dataPerBlock1, blocks2] (dataPerBlock2 = dataPerBlock1 + 1)
  [0, 0, 0, 0], [10, 1, 16, 0], [16, 1, 28, 0], [26, 1, 44, 0], [18, 2, 32, 0], [24, 2, 43, 0], [16, 4, 27, 0], [18, 4, 31, 0], [22, 2, 38, 2], [22, 3, 36, 2], [26, 4, 43, 1],
];
const ALIGN: number[][] = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// GF(256) tables for Reed-Solomon
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!; })();
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a]! + LOG[b]!]! : 0);

function rsRemainder(data: number[], ecLen: number): number[] {
  let gen = [1];
  for (let i = 0; i < ecLen; i++) { const next = new Array(gen.length + 1).fill(0); for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]!; next[j + 1] ^= mul(gen[j]!, EXP[i]!); } gen = next; }
  const res = new Array(ecLen).fill(0);
  for (const d of data) { const f = d ^ res.shift()!; res.push(0); if (f) for (let j = 0; j < ecLen; j++) res[j] ^= mul(gen[j + 1]!, f); }
  return res;
}

function capacity(v: number): number { const [, b1, d1, b2] = EC_M[v]!; return b1 * d1 + b2 * (d1 + 1); }

/** Returns the module matrix (true = dark) or null when the text is too long. */
export function qrMatrix(text: string): boolean[][] | null {
  const bytes = [...new TextEncoder().encode(text)];
  let v = 1;
  while (v <= 10 && capacity(v) < bytes.length + (v < 10 ? 2 : 3)) v++;
  if (v > 10) return null;
  const [ecLen, b1, d1, b2] = EC_M[v]!;
  const totalData = b1 * d1 + b2 * (d1 + 1);
  // bit stream: mode 0100, length (8 bits for v<10, 16 for v10), data, terminator, pad
  const bits: number[] = [];
  const push = (val: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(4, 4); push(bytes.length, v < 10 ? 8 : 16); for (const b of bytes) push(b, 8);
  push(0, Math.min(4, totalData * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data: number[] = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let p = 0; data.length < totalData; p++) data.push(p % 2 ? 0x11 : 0xec);
  // blocks
  const blocks: number[][] = [], ecs: number[][] = [];
  let off = 0;
  for (let i = 0; i < b1 + b2; i++) { const len = i < b1 ? d1 : d1 + 1; const blk = data.slice(off, off + len); off += len; blocks.push(blk); ecs.push(rsRemainder(blk, ecLen)); }
  const out: number[] = [];
  for (let i = 0; i < d1 + 1; i++) for (const blk of blocks) if (i < blk.length) out.push(blk[i]!);
  for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i]!);
  // matrix
  const size = v * 4 + 17;
  const m: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r: number, c: number, val: boolean) => { m[r]![c] = val; fn[r]![c] = true; };
  const finder = (r: number, c: number) => { for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) { const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue; const on = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)); set(rr, cc, on); } };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[v]!;
  for (const r of al) for (const c of al) { if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue; for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1); }
  set(size - 8, 8, true);
  for (let i = 0; i < 9; i++) { if (i !== 6) { fn[8]![i] = true; fn[i]![8] = true; } }
  for (let i = 0; i < 8; i++) { fn[8]![size - 1 - i] = true; fn[size - 1 - i]![8] = true; }
  if (v >= 7) { // version information (18 bits, BCH 18,6) beside the top-right and bottom-left finders
    let rem = v; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vb = (v << 12) | rem;
    for (let i = 0; i < 18; i++) { const bit = ((vb >> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3); set(b, a, bit); set(a, b, bit); }
  }
  // place data
  let bi = 0; const total = out.length * 8;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) {
      const r = upward ? size - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (fn[r]![c]) continue;
        const bit = bi < total ? (out[bi >> 3]! >> (7 - (bi & 7))) & 1 : 0; bi++;
        m[r]![c] = bit === 1;
      }
    }
    upward = !upward;
  }
  // mask + format
  const MASKS = [(r: number, c: number) => (r + c) % 2 === 0, (r: number) => r % 2 === 0, (_r: number, c: number) => c % 3 === 0, (r: number, c: number) => (r + c) % 3 === 0,
    (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
  const apply = (mask: number): boolean[][] => {
    const g = m.map((row) => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (!fn[r]![c] && MASKS[mask]!(r, c)) g[r]![c] = !g[r]![c];
    let f = (0b00 << 3) | mask; // EC level M = 00
    let rem = f << 10; for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
    f = ((f << 10) | rem) ^ 0x5412;
    const fb = (i: number) => ((f >> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) g[i]![8] = fb(i);
    g[7]![8] = fb(6); g[8]![8] = fb(7); g[8]![7] = fb(8);
    for (let i = 9; i < 15; i++) g[8]![14 - i] = fb(i);
    for (let i = 0; i < 8; i++) g[8]![size - 1 - i] = fb(i);
    for (let i = 8; i < 15; i++) g[size - 15 + i]![8] = fb(i);
    g[size - 8]![8] = true;
    return g;
  };
  const penalty = (g: boolean[][]): number => {
    let p = 0;
    for (let r = 0; r < size; r++) { let run = 1; for (let c = 1; c < size; c++) { if (g[r]![c] === g[r]![c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let c = 0; c < size; c++) { let run = 1; for (let r = 1; r < size; r++) { if (g[r]![c] === g[r - 1]![c]) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) { const a = g[r]![c]; if (a === g[r]![c + 1] && a === g[r + 1]![c] && a === g[r + 1]![c + 1]) p += 3; }
    const dark = g.flat().filter(Boolean).length; p += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return p;
  };
  let best: boolean[][] | null = null, bestP = Infinity;
  for (let mask = 0; mask < 8; mask++) { const g = apply(mask); const p = penalty(g); if (p < bestP) { bestP = p; best = g; } }
  return best;
}

/** SVG string for the matrix (quiet zone 2 modules). */
export function qrSvg(text: string, px = 200): string {
  const m = qrMatrix(text);
  if (!m) return "";
  const n = m.length, q = 2, total = n + q * 2;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r]![c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="QR-Code"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
