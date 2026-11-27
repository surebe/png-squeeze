// png-squeeze: a lossless PNG recompressor for 1280x720 RGBA screenshots.
// Reads /input/<id>/image.png, writes the same pixels to /output/<id>/image.png in as few bytes as possible:
// colour-form reduction (palette / grey / RGB / tRNS keying), per-row filter selection weighed by a simulated
// LZ77 parse, and an optimal-parse DEFLATE (shortest-path over match candidates with iterated Huffman costs,
// block splitting, exact dynamic-header accounting) built only on node:zlib's inflate and raw streams.
import { deflateRawSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- PNG basics

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Filter one row of `stride` bytes into out[0..stride); type is the PNG filter type, bpp bytes per pixel. */
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  if (type === 0) {
    out.set(cur);
    return;
  }
  if (type === 1) {
    for (let i = 0; i < cur.length; i++) out[i] = (cur[i] - (i >= bpp ? cur[i - bpp] : 0)) & 0xff;
    return;
  }
  if (type === 2) {
    if (prev === null) out.set(cur);
    else for (let i = 0; i < cur.length; i++) out[i] = (cur[i] - prev[i]) & 0xff;
    return;
  }
  if (type === 3) {
    for (let i = 0; i < cur.length; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      out[i] = (cur[i] - ((a + b) >> 1)) & 0xff;
    }
    return;
  }
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev === null ? 0 : prev[i];
    const c = prev === null || i < bpp ? 0 : prev[i - bpp];
    out[i] = (cur[i] - paeth(a, b, c)) & 0xff;
  }
}

/** Decode any contest-format PNG to RGBA bytes. Throws on anything outside the accepted format. */
function decodePng(buf: Uint8Array): { rgba: Uint8Array; width: number; height: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0;
  let height = 0;
  let colourType = 6;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let at = 8;
  while (at < buf.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(buf[at + 4], buf[at + 5], buf[at + 6], buf[at + 7]);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      colourType = buf[at + 8 + 9];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    at += 12 + len;
  }
  let zlen = 0;
  for (const part of idat) zlen += part.length;
  const z = new Uint8Array(zlen);
  let zo = 0;
  for (const part of idat) {
    z.set(part, zo);
    zo += part.length;
  }
  const raw = new Uint8Array(inflateSync(z));
  const ch = CHANNELS[colourType];
  const stride = width * ch;
  const samples = new Uint8Array(height * stride);
  // Unfilter.
  const rowBytes = stride + 1;
  for (let y = 0; y < height; y++) {
    const ft = raw[y * rowBytes];
    const src = raw.subarray(y * rowBytes + 1, (y + 1) * rowBytes);
    const dst = samples.subarray(y * stride, (y + 1) * stride);
    const up = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    if (ft === 0) dst.set(src);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) dst[i] = (src[i] + (i >= ch ? dst[i - ch] : 0)) & 0xff;
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) dst[i] = (src[i] + (up === null ? 0 : up[i])) & 0xff;
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? dst[i - ch] : 0;
        const b = up === null ? 0 : up[i];
        dst[i] = (src[i] + ((a + b) >> 1)) & 0xff;
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= ch ? dst[i - ch] : 0;
        const b = up === null ? 0 : up[i];
        const c = up === null || i < ch ? 0 : up[i - ch];
        dst[i] = (src[i] + paeth(a, b, c)) & 0xff;
      }
    }
  }
  // Expand to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    let key = -1;
    if (trns !== null && trns.length === 6) key = (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      const v = (samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2];
      rgba[d + 3] = key !== -1 && v === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    let key = -1;
    if (trns !== null && trns.length === 2) key = trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = key !== -1 && g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    // Palette.
    if (plte === null) throw new Error('palette image without PLTE');
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const idx = samples[i];
      rgba[d] = plte[idx * 3];
      rgba[d + 1] = plte[idx * 3 + 1];
      rgba[d + 2] = plte[idx * 3 + 2];
      rgba[d + 3] = trns !== null && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { rgba, width, height };
}

/** Assemble a PNG file from [type, data] chunks with correct CRCs. */
function pngOf(chunks: [string, Uint8Array][]): Uint8Array {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const out = new Uint8Array(13);
  const view = new DataView(out.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  out[8] = 8; // bit depth
  out[9] = colourType;
  return out;
}

/** Wrap a raw DEFLATE stream as a zlib stream (header + adler32). */
function zlibWrap(raw: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length + 6);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(raw, 2);
  const ad = adler32(data);
  const o = raw.length + 2;
  out[o] = (ad >>> 24) & 0xff;
  out[o + 1] = (ad >>> 16) & 0xff;
  out[o + 2] = (ad >>> 8) & 0xff;
  out[o + 3] = ad & 0xff;
  return out;
}

// ---------------------------------------------------------------- Image forms

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  chunkBytes: number; // PLTE + tRNS chunk cost in the file (12 bytes overhead each)
}

function analyse(rgba: Uint8Array): { opaque: boolean; grey: boolean; colours: { rgba: number[]; word: number; count: number }[] | null } {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many
    ? null
    : [...counts.keys()].map((c) => {
        const b = new Uint8Array(Uint32Array.of(c).buffer);
        return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) as number };
      });
  return { opaque, grey, colours };
}

/** The single fully-transparent colour value usable as a tRNS key, or null. */
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteForm(rgba: Uint8Array, colours: { rgba: number[]; word: number; count: number }[], order: string): Form {
  const lum = (c: { rgba: number[] }) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = order === 'scan' ? [...colours] : [...colours].sort((x, y) => {
    if (order !== 'plain') {
      const ta = x.rgba[3] === 255 ? 1 : 0;
      const tb = y.rgba[3] === 255 ? 1 : 0;
      if (ta !== tb) return ta - tb;
      if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    }
    if (order === 'count') return y.count - x.count || x.word - y.word;
    return lum(x) - lum(y) || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return {
    colourType: 3,
    bpp: 1,
    samples: indices,
    plte,
    trns,
    chunkBytes: 12 + plte.length + (trns === null ? 0 : 12 + trns.length),
  };
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    forms.push(paletteForm(rgba, colours, 'plain'));
    forms.push(paletteForm(rgba, colours, 'scan'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[ct];
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    chunkBytes: trns === null ? 0 : 12 + trns.length,
  });
  return forms;
}

// ---------------------------------------------------------------- Filtering

/** Sum of |signed byte| over a filtered row: the minimum-sum heuristic's cost. */
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const b = row[i];
    s += b < 128 ? b : 256 - b;
  }
  return s;
}

/** Order-0 entropy estimate (bits) of a filtered row from its own byte histogram. */
function entropyBits(row: Uint8Array, hist: Int32Array): number {
  hist.fill(0);
  for (let i = 0; i < row.length; i++) hist[row[i]]++;
  let bits = 0;
  const n = row.length;
  for (let v = 0; v < 256; v++) {
    const c = hist[v];
    if (c > 0) bits += c * Math.log2(n / c);
  }
  return bits;
}

/**
 * The filtered byte stream of a form's samples under a fixed filter (0-4) or a per-row heuristic
 * ('minsum' | 'entropy'). Written into `raw` when given and of the right size.
 */
function filteredSamples(samples: Uint8Array, width: number, height: number, bpp: number, choice: number | string, raw?: Uint8Array): Uint8Array {
  const stride = width * bpp;
  const out = raw !== undefined && raw.length === height * (stride + 1) ? raw : new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const hist = new Int32Array(256);
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      out[at] = choice;
      filterRow(choice, cur, prev, bpp, out.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      const cost = choice === 'minsum' ? signedSum(trial[t]) : entropyBits(trial[t], hist);
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    out[at] = type;
    out.set(trial[type], at + 1);
  }
  return out;
}

// ---------------------------------------------------------------- DEFLATE tables

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** The largest length each length-code covers: the only lengths a shortest path ever needs from one match. */
const LEN_MAXIMA = [3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 22, 26, 30, 34, 42, 50, 58, 66, 82, 98, 114, 130, 162, 194, 226, 257, 258];

const LEN_CODE = new Uint8Array(259);
const LEN_COST_EXTRA = new Uint8Array(259);
for (let c = 0; c < 29; c++) {
  const hi = c === 28 ? 258 : LEN_BASE[c] + (1 << LEN_EXTRA[c]) - 1;
  for (let l = LEN_BASE[c]; l <= hi; l++) {
    LEN_CODE[l] = c;
    LEN_COST_EXTRA[l] = LEN_EXTRA[c];
  }
}
const DIST_CODE = new Uint8Array(32769);
const DIST_COST_EXTRA = new Uint8Array(32769);
for (let c = 0; c < 30; c++) {
  const hi = DIST_BASE[c] + (1 << DIST_EXTRA[c]) - 1;
  for (let d = DIST_BASE[c]; d <= hi; d++) {
    DIST_CODE[d] = c;
    DIST_COST_EXTRA[d] = DIST_EXTRA[c];
  }
}

/** Huffman code lengths (each at most maxLen, a complete code when at least two symbols are used). */
function huffmanLengths(freq: Uint32Array, maxLen: number): Uint8Array {
  const lengths = new Uint8Array(freq.length);
  const leaves: { s: number; w: number }[] = [];
  for (let i = 0; i < freq.length; i++) if (freq[i] > 0) leaves.push({ s: i, w: freq[i] });
  if (leaves.length === 0) return lengths;
  if (leaves.length === 1) {
    lengths[leaves[0].s] = 1;
    return lengths;
  }
  leaves.sort((a, b) => a.w - b.w || a.s - b.s);
  // Package-merge (Katajainen/Moffat/Turpin): each round packages consecutive
  // pairs of the current list and merges the packages back with the leaves.
  // After maxLen rounds, a symbol's code length is the number of times it
  // occurs in the first 2m-2 items. Exact: the result is always a complete
  // prefix code with every length <= maxLen.
  type Item = { w: number; syms: number[] };
  const leafItems: Item[] = leaves.map((l) => ({ w: l.w, syms: [l.s] }));
  let list: Item[] = leafItems;
  for (let round = 0; round < maxLen - 1; round++) {
    const packs: Item[] = [];
    for (let i = 0; i + 1 < list.length; i += 2) {
      packs.push({ w: list[i].w + list[i + 1].w, syms: list[i].syms.concat(list[i + 1].syms) });
    }
    const merged: Item[] = [];
    let a = 0;
    let b = 0;
    while (a < leafItems.length || b < packs.length) {
      if (b >= packs.length || (a < leafItems.length && leafItems[a].w <= packs[b].w)) merged.push(leafItems[a++]);
      else merged.push(packs[b++]);
    }
    list = merged;
  }
  const need = 2 * leaves.length - 2;
  for (let i = 0; i < need && i < list.length; i++) {
    for (const s of list[i].syms) lengths[s]++;
  }
  return lengths;
}

/** Canonical codes (bit-reversed for the DEFLATE bit order) from code lengths. */
function canonicalCodes(lengths: Uint8Array): { code: Uint32Array; rev: Uint32Array } {
  const maxLen = Math.max(...lengths);
  const count = new Int32Array(maxLen + 1);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) count[lengths[i]]++;
  const next = new Int32Array(maxLen + 1);
  let c = 0;
  for (let l = 1; l <= maxLen; l++) {
    c = (c + count[l - 1]) << 1;
    next[l] = c;
  }
  const code = new Uint32Array(lengths.length);
  const rev = new Uint32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    if (lengths[s] === 0) continue;
    const v = next[lengths[s]]++;
    code[s] = v;
    let r = 0;
    for (let b = 0; b < lengths[s]; b++) r = (r << 1) | ((v >>> b) & 1);
    rev[s] = r;
  }
  return { code, rev };
}

// ---------------------------------------------------------------- Optimal DEFLATE

const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const MAX_PAIRS = 6;

interface MatchSet {
  cnt: Uint8Array; // pairs per position
  len: Uint16Array; // packed [pos * MAX_PAIRS + k]
  dist: Uint16Array;
}

/** Find, for every position, up to MAX_PAIRS Pareto-optimal (length, distance) matches. */
function findMatches(data: Uint8Array, chainCap?: number): MatchSet {
  const n = data.length;
  const cnt = new Uint8Array(n);
  const len = new Uint16Array(n * MAX_PAIRS);
  const dist = new Uint16Array(n * MAX_PAIRS);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const maxChain = chainCap ?? (n > 2_000_000 ? 128 : 192);
  for (let i = 0; i + 2 < n; i++) {
    const h = (((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2]) * 0x9e3779b1) >>> (32 - HASH_BITS) & (HASH_SIZE - 1);
    let p = head[h];
    let tries = 0;
    let bestLen = 2;
    const maxLen = Math.min(258, n - i);
    const base = i * MAX_PAIRS;
    let pairs = 0;
    while (p >= 0 && tries < maxChain) {
      const d = i - p;
      if (d > 32768) break;
      // A candidate only matters if it can beat the best length so far: test the byte at bestLen first.
      if (bestLen < maxLen && data[p + bestLen] === data[i + bestLen]) {
        let l = 0;
        while (l < maxLen && data[p + l] === data[i + l]) l++;
        if (l >= 3) {
          // Pareto insert: skip if dominated; drop pairs this one dominates.
          let dominated = false;
          for (let k = 0; k < pairs; k++) {
            if (len[base + k] >= l && dist[base + k] <= d) {
              dominated = true;
              break;
            }
          }
          if (!dominated) {
            let w = 0;
            for (let k = 0; k < pairs; k++) {
              if (!(len[base + k] <= l && dist[base + k] >= d)) {
                len[base + w] = len[base + k];
                dist[base + w] = dist[base + k];
                w++;
              }
            }
            pairs = w;
            if (pairs < MAX_PAIRS) {
              len[base + pairs] = l;
              dist[base + pairs] = d;
              pairs++;
            }
          }
          if (l > bestLen) {
            bestLen = l;
            if (l >= 258) break;
            if (l >= 64 && tries >= 12) break;
          }
        }
      }
      p = prev[p];
      tries++;
    }
    cnt[i] = pairs;
    prev[i] = head[h];
    head[h] = i;
  }
  return { cnt, len, dist };
}

interface Parse {
  // Symbol stream: for each symbol, len 0 = literal (dist holds the byte), else a match of len/dist.
  symLen: Int32Array;
  symDist: Int32Array;
  symPos: Int32Array; // byte offset of each symbol
  count: number;
}

/** Greedy parse from the match set: frequencies seed the first cost model. */
function greedyParse(data: Uint8Array, ms: MatchSet): Parse {
  const n = data.length;
  // First pass counts symbols so the result arrays are exact-sized.
  let count = 0;
  let i = 0;
  while (i < n) {
    let bl = 0;
    const base = i * MAX_PAIRS;
    for (let k = 0; k < ms.cnt[i]; k++) if (ms.len[base + k] > bl) bl = ms.len[base + k];
    i += bl >= 3 ? bl : 1;
    count++;
  }
  const symLen = new Int32Array(count);
  const symDist = new Int32Array(count);
  const symPos = new Int32Array(count);
  let c = 0;
  i = 0;
  while (i < n) {
    let bl = 0;
    let bd = 0;
    const base = i * MAX_PAIRS;
    for (let k = 0; k < ms.cnt[i]; k++) {
      const L = ms.len[base + k];
      const d = ms.dist[base + k];
      if (L > bl || (L === bl && (bd === 0 || d < bd))) {
        bl = L;
        bd = d;
      }
    }
    symPos[c] = i;
    if (bl >= 3) {
      symLen[c] = bl;
      symDist[c] = bd;
      i += bl;
    } else {
      symLen[c] = 0;
      symDist[c] = data[i];
      i += 1;
    }
    c++;
  }
  return { symLen, symDist, symPos, count };
}

/** Symbol frequencies of a parse, for building Huffman cost models. */
function parseFreqs(parse: Parse): { lit: Uint32Array; dist: Uint32Array } {
  const lit = new Uint32Array(288);
  const dist = new Uint32Array(32);
  for (let i = 0; i < parse.count; i++) {
    if (parse.symLen[i] === 0) lit[parse.symDist[i]]++;
    else {
      lit[257 + LEN_CODE[parse.symLen[i]]]++;
      dist[DIST_CODE[parse.symDist[i]]]++;
    }
  }
  return { lit, dist };
}

/** Scratch buffers for dpParse, reused across calls (grown on demand). */
const dpScratch: { cost: Float64Array; chLen: Int32Array; chDist: Int32Array } = {
  cost: new Float64Array(0),
  chLen: new Int32Array(0),
  chDist: new Int32Array(0),
};

/**
 * Shortest-path parse under the given symbol costs: a literal transition and,
 * for every match candidate, transitions at every length-code boundary.
 */
function dpParse(data: Uint8Array, ms: MatchSet, litCost: Float64Array, lenCost: Float64Array, distCost: Float64Array): Parse {
  const n = data.length;
  // Scratch buffers reused across calls (grown on demand) to cut GC churn.
  if (dpScratch.cost.length < n + 1) {
    dpScratch.cost = new Float64Array(n + 1);
    dpScratch.chLen = new Int32Array(n + 1);
    dpScratch.chDist = new Int32Array(n + 1);
  }
  const cost = dpScratch.cost;
  const chLen = dpScratch.chLen;
  const chDist = dpScratch.chDist;
  cost.fill(Infinity, 0, n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci === Infinity) continue;
    const lc = ci + litCost[data[i]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      chLen[i + 1] = 0;
      chDist[i + 1] = 0;
    }
    const base = i * MAX_PAIRS;
    for (let k = 0; k < ms.cnt[i]; k++) {
      const L = ms.len[base + k];
      const dc = distCost[ms.dist[base + k]];
      for (let t = 0; t < LEN_MAXIMA.length; t++) {
        const l = LEN_MAXIMA[t];
        if (l > L) break;
        const j = i + l;
        const c = ci + lenCost[l] + dc;
        if (c < cost[j]) {
          cost[j] = c;
          chLen[j] = l;
          chDist[j] = ms.dist[base + k];
        }
      }
    }
  }
  // Walk the choices back from n (count first, then fill exact-sized arrays).
  let count = 0;
  let j = n;
  while (j > 0) {
    const l = chLen[j];
    j -= l === 0 ? 1 : l;
    count++;
  }
  const symLen = new Int32Array(count);
  const symDist = new Int32Array(count);
  const symPos = new Int32Array(count);
  let c = 0;
  j = n;
  while (j > 0) {
    const l = chLen[j];
    symPos[c] = j - (l === 0 ? 1 : l);
    if (l === 0) {
      symLen[c] = 0;
      symDist[c] = data[j - 1];
      j -= 1;
    } else {
      symLen[c] = l;
      symDist[c] = chDist[j];
      j -= l;
    }
    c++;
  }
  // Reverse in place.
  for (let a = 0, b = count - 1; a < b; a++, b--) {
    let t = symLen[a];
    symLen[a] = symLen[b];
    symLen[b] = t;
    t = symDist[a];
    symDist[a] = symDist[b];
    symDist[b] = t;
    t = symPos[a];
    symPos[a] = symPos[b];
    symPos[b] = t;
  }
  return { symLen: symLen.subarray(0, count), symDist: symDist.subarray(0, count), symPos: symPos.subarray(0, count), count };
}

// ---------------------------------------------------------------- Block encoding

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** RLE-encode a code-length sequence into code-length-alphabet symbols: [symbol, extraValue, extraBits][]. */
function rleLengths(seq: Uint8Array): [number, number, number][] {
  const out: [number, number, number][] = [];
  let i = 0;
  while (i < seq.length) {
    const v = seq[i];
    let run = 1;
    while (i + run < seq.length && seq[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        out.push([18, take - 11, 7]);
        left -= take;
      }
      while (left >= 3) {
        const take = Math.min(left, 10);
        out.push([17, take - 3, 3]);
        left -= take;
      }
      while (left-- > 0) out.push([0, 0, 0]);
    } else {
      out.push([v, 0, 0]);
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        out.push([16, take - 3, 2]);
        left -= take;
      }
      while (left-- > 0) out.push([v, 0, 0]);
    }
    i += run;
  }
  return out;
}

interface BlockPlan {
  bits: number;
  dynamic: boolean;
  litLen: Uint8Array;
  distLen: Uint8Array;
  headerBits: number;
}

/** The exact bit cost of one block holding symbols [from, to) of a parse, choosing dynamic vs static Huffman. */
function planBlock(parse: Parse, from: number, to: number): BlockPlan {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(32);
  for (let s = from; s < to; s++) {
    const l = parse.symLen[s];
    if (l === 0) litFreq[parse.symDist[s]]++;
    else {
      litFreq[257 + LEN_CODE[l]]++;
      distFreq[DIST_CODE[parse.symDist[s]]]++;
    }
  }
  litFreq[256]++;
  // Extra bits are identical for static and dynamic bodies.
  let extraBits = 0;
  for (let s = from; s < to; s++) {
    const l = parse.symLen[s];
    if (l > 0) extraBits += LEN_EXTRA[LEN_CODE[l]] + DIST_EXTRA[DIST_CODE[parse.symDist[s]]];
  }
  // Static block cost.
  let staticBits = 3 + extraBits;
  for (let s = 0; s < 288; s++) {
    if (litFreq[s] === 0) continue;
    staticBits += litFreq[s] * (s <= 143 ? 8 : s <= 255 ? 9 : s <= 279 ? 7 : 8);
  }
  for (let s = 0; s < 32; s++) staticBits += distFreq[s] * 5;
  // Dynamic block cost.
  const litLen = huffmanLengths(litFreq, 15);
  const distLen = huffmanLengths(distFreq, 15);
  // An alphabet reduced to a single used symbol still needs a complete code for strict inflaters:
  // light up one unused symbol at length 1 (never emitted, costs header bits only).
  const fixSingle = (lengths: Uint8Array, freq: Uint32Array) => {
    let usedCount = 0;
    let single = -1;
    for (let s = 0; s < lengths.length; s++) {
      if (freq[s] > 0) {
        usedCount++;
        single = s;
      }
    }
    if (usedCount === 1 && lengths[single] === 1) {
      for (let s = 0; s < lengths.length; s++) {
        if (s !== single) {
          lengths[s] = 1;
          break;
        }
      }
    }
    if (usedCount === 0) {
      lengths[0] = 1;
      lengths[1] = 1;
    }
  };
  fixSingle(litLen, litFreq);
  fixSingle(distLen, distFreq);
  let hlit = 257;
  for (let s = 287; s >= 257; s--) {
    if (litLen[s] > 0) {
      hlit = s + 1;
      break;
    }
  }
  let hdist = 1;
  for (let s = 31; s >= 1; s--) {
    if (distLen[s] > 0) {
      hdist = s + 1;
      break;
    }
  }
  const seq = new Uint8Array(hlit + hdist);
  seq.set(litLen.subarray(0, hlit), 0);
  seq.set(distLen.subarray(0, hdist), hlit);
  const rle = rleLengths(seq);
  const clFreq = new Uint32Array(19);
  for (const [sym] of rle) clFreq[sym]++;
  const clLen = huffmanLengths(clFreq, 7);
  {
    let usedCount = 0;
    let single = -1;
    for (let s = 0; s < 19; s++) {
      if (clFreq[s] > 0) {
        usedCount++;
        single = s;
      }
    }
    if (usedCount === 1 && clLen[single] === 1) {
      for (let s = 0; s < 19; s++) {
        if (s !== single) {
          clLen[s] = 1;
          break;
        }
      }
    }
  }
  let hclen = 4;
  for (let k = 18; k >= 4; k--) {
    if (clLen[CL_ORDER[k]] > 0) {
      hclen = k + 1;
      break;
    }
  }
  let headerBits = 5 + 5 + 4 + 3 * hclen;
  for (const [sym, , eb] of rle) headerBits += clLen[sym] + eb;
  let bodyBits = extraBits;
  for (let s = 0; s < 288; s++) if (litFreq[s] > 0) bodyBits += litFreq[s] * litLen[s];
  for (let s = 0; s < 32; s++) if (distFreq[s] > 0) bodyBits += distFreq[s] * distLen[s];
  const dynamicBits = 3 + headerBits + bodyBits;
  if (dynamicBits <= staticBits) return { bits: dynamicBits, dynamic: true, litLen, distLen, headerBits };
  return { bits: staticBits, dynamic: false, litLen, distLen, headerBits };
}

class BitWriter {
  bytes: number[] = [];
  acc = 0;
  nbits = 0;
  writeBits(value: number, count: number): void {
    this.acc |= value << this.nbits;
    this.nbits += count;
    while (this.nbits >= 8) {
      this.bytes.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.nbits -= 8;
    }
  }
  /** Write a Huffman code given in bit-reversed form. */
  writeCode(rev: number, count: number): void {
    this.writeBits(rev, count);
  }
  finish(): Uint8Array {
    if (this.nbits > 0) this.bytes.push(this.acc & 0xff);
    return Uint8Array.from(this.bytes);
  }
}

const FIXED_LIT_LEN = (() => {
  const a = new Uint8Array(288);
  for (let s = 0; s < 288; s++) a[s] = s <= 143 ? 8 : s <= 255 ? 9 : s <= 279 ? 7 : 8;
  return a;
})();
const FIXED_DIST_LEN = new Uint8Array(32).fill(5);

/** Encode symbols [from, to) of a parse as one DEFLATE block (without the final-block flag handling of BFINAL=last). */
function encodeBlock(w: BitWriter, parse: Parse, from: number, to: number, last: boolean, plan: BlockPlan): void {
  w.writeBits(last ? 1 : 0, 1);
  if (!plan.dynamic) {
    w.writeBits(1, 2);
    const lit = canonicalCodes(FIXED_LIT_LEN);
    const dst = canonicalCodes(FIXED_DIST_LEN);
    writeSymbols(w, parse, from, to, lit, FIXED_LIT_LEN, dst, FIXED_DIST_LEN);
    return;
  }
  w.writeBits(2, 2);
  const litLen = plan.litLen;
  const distLen = plan.distLen;
  let hlit = 257;
  for (let s = 287; s >= 257; s--) {
    if (litLen[s] > 0) {
      hlit = s + 1;
      break;
    }
  }
  let hdist = 1;
  for (let s = 31; s >= 1; s--) {
    if (distLen[s] > 0) {
      hdist = s + 1;
      break;
    }
  }
  const seq = new Uint8Array(hlit + hdist);
  seq.set(litLen.subarray(0, hlit), 0);
  seq.set(distLen.subarray(0, hdist), hlit);
  const rle = rleLengths(seq);
  const clFreq = new Uint32Array(19);
  for (const [sym] of rle) clFreq[sym]++;
  const clLen = huffmanLengths(clFreq, 7);
  {
    let usedCount = 0;
    let single = -1;
    for (let s = 0; s < 19; s++) {
      if (clFreq[s] > 0) {
        usedCount++;
        single = s;
      }
    }
    if (usedCount === 1 && clLen[single] === 1) {
      for (let s = 0; s < 19; s++) {
        if (s !== single) {
          clLen[s] = 1;
          break;
        }
      }
    }
  }
  let hclen = 4;
  for (let k = 18; k >= 4; k--) {
    if (clLen[CL_ORDER[k]] > 0) {
      hclen = k + 1;
      break;
    }
  }
  w.writeBits(hlit - 257, 5);
  w.writeBits(hdist - 1, 5);
  w.writeBits(hclen - 4, 4);
  const cl = canonicalCodes(clLen);
  for (let k = 0; k < hclen; k++) w.writeBits(clLen[CL_ORDER[k]], 3);
  for (const [sym, extra, eb] of rle) {
    w.writeCode(cl.rev[sym], clLen[sym]);
    if (eb > 0) w.writeBits(extra, eb);
  }
  const lit = canonicalCodes(litLen);
  const dst = canonicalCodes(distLen);
  writeSymbols(w, parse, from, to, lit, litLen, dst, distLen);
}

function writeSymbols(
  w: BitWriter,
  parse: Parse,
  from: number,
  to: number,
  lit: { code: Uint32Array; rev: Uint32Array },
  litLen: Uint8Array,
  dst: { code: Uint32Array; rev: Uint32Array },
  distLen: Uint8Array,
): void {
  for (let s = from; s < to; s++) {
    const l = parse.symLen[s];
    if (l === 0) {
      const b = parse.symDist[s];
      w.writeCode(lit.rev[b], litLen[b]);
    } else {
      const lc = 257 + LEN_CODE[l];
      w.writeCode(lit.rev[lc], litLen[lc]);
      const le = LEN_EXTRA[LEN_CODE[l]];
      if (le > 0) w.writeBits(l - LEN_BASE[LEN_CODE[l]], le);
      const d = parse.symDist[s];
      const dc = DIST_CODE[d];
      w.writeCode(dst.rev[dc], distLen[dc]);
      const de = DIST_EXTRA[dc];
      if (de > 0) w.writeBits(d - DIST_BASE[dc], de);
    }
  }
  w.writeCode(lit.rev[256], litLen[256]);
}

/** The best DEFLATE (as a zlib stream) we can make of `data`: optimal parse + block-split choice, vs zlib level 9. */
function deflateBest(data: Uint8Array, light = false): Uint8Array {
  // Release the DP scratch up front so its peak does not stack with the
  // match tables being built below; dpParse regrows it on demand.
  dpScratch.cost = new Float64Array(0);
  dpScratch.chLen = new Int32Array(0);
  dpScratch.chDist = new Int32Array(0);
  const fallback = new Uint8Array(deflateRawSync(data, { level: 9 }));
  let best = zlibWrap(fallback, data);
  try {
    let ms = findMatches(data);
    let parse = greedyParse(data, ms);
    let litLen = new Uint8Array(288);
    let distLen = new Uint8Array(32);
    let prevBits = Infinity;
    const maxIter = light ? 3 : data.length > 2_000_000 ? 3 : 4;
    for (let iter = 0; iter < maxIter; iter++) {
      const freq = parseFreqs(parse);
      litLen = huffmanLengths(freq.lit, 15);
      distLen = huffmanLengths(freq.dist, 15);
      const litCost = new Float64Array(288);
      for (let s = 0; s < 288; s++) litCost[s] = litLen[s] === 0 ? 24 : litLen[s];
      const lenCost = new Float64Array(259);
      for (let l = 3; l <= 258; l++) lenCost[l] = litCost[257 + LEN_CODE[l]] + LEN_COST_EXTRA[l];
      const distCost = new Float64Array(32769);
      for (let d = 1; d <= 32768; d++) {
        const dl = distLen[DIST_CODE[d]];
        distCost[d] = (dl === 0 ? 24 : dl) + DIST_COST_EXTRA[d];
      }
      parse = dpParse(data, ms, litCost, lenCost, distCost);
      if (iter === 0) {
        // If the optimal path is already clearly worse than the zlib stream,
        // stop spending time on it (the fallback is returned below anyway) —
        // unless this stream qualifies for the deep-chain rescue pass.
        const deepCandidate = data.length >= 1_500_000 && data.length <= 3_000_000;
        if (!deepCandidate && planBlock(parse, 0, parse.count).bits > (best.length - 6) * 8 * 1.03) return best;
      }
      if (iter >= 1) {
        const bits = planBlock(parse, 0, parse.count).bits;
        if (prevBits - bits < prevBits * 0.003) break;
        prevBits = bits;
      }
    }
    // Repetitive streams (long average matches) hide their best matches deep
    // in the hash chains: re-search with a much deeper chain and refine.
    if (!light && data.length >= 1_500_000 && data.length <= 3_000_000 && data.length / parse.count >= 40) {
      const before = planBlock(parse, 0, parse.count).bits;
      const oldParse = parse;
      ms = findMatches(data, 1024);
      for (let iter = 0; iter < 1; iter++) {
        const freq = parseFreqs(parse);
        litLen = huffmanLengths(freq.lit, 15);
        distLen = huffmanLengths(freq.dist, 15);
        const litCost = new Float64Array(288);
        for (let s = 0; s < 288; s++) litCost[s] = litLen[s] === 0 ? 24 : litLen[s];
        const lenCost = new Float64Array(259);
        for (let l = 3; l <= 258; l++) lenCost[l] = litCost[257 + LEN_CODE[l]] + LEN_COST_EXTRA[l];
        const distCost = new Float64Array(32769);
        for (let d = 1; d <= 32768; d++) {
          const dl = distLen[DIST_CODE[d]];
          distCost[d] = (dl === 0 ? 24 : dl) + DIST_COST_EXTRA[d];
        }
        parse = dpParse(data, ms, litCost, lenCost, distCost);
      }
      if (planBlock(parse, 0, parse.count).bits >= before) parse = oldParse;
    }
    // Choose a block segmentation by total planned bits.
    const n = data.length;
    let bestSeg: number[] = [0, parse.count];
    let bestBits = Infinity;
    for (const segs of [1, 2, 3, 4, 6, 8, 12]) {
      const bounds: number[] = [0];
      for (let k = 1; k < segs; k++) {
        const target = Math.floor((n * k) / segs);
        // The symbol whose span covers target.
        let lo = 0;
        let hi = parse.count;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (parse.symPos[mid] < target) lo = mid + 1;
          else hi = mid;
        }
        if (lo > 0 && lo < parse.count && lo !== bounds[bounds.length - 1]) bounds.push(lo);
      }
      bounds.push(parse.count);
      let bits = 0;
      for (let b = 0; b + 1 < bounds.length; b++) bits += planBlock(parse, bounds[b], bounds[b + 1]).bits;
      if (bits < bestBits) {
        bestBits = bits;
        bestSeg = bounds;
      }
    }
    const w = new BitWriter();
    for (let b = 0; b + 1 < bestSeg.length; b++) {
      const plan = planBlock(parse, bestSeg[b], bestSeg[b + 1]);
      encodeBlock(w, parse, bestSeg[b], bestSeg[b + 1], b + 2 === bestSeg.length, plan);
    }
    const ours = zlibWrap(w.finish(), data);
    if (ours.length < best.length) best = ours;
  } catch {
    // Any failure in the optimal path leaves the zlib stream, which is always valid.
  }
  return best;
}

/** Symbol cost tables from a parse, in the shape dpParse and the row scorer use. */
function costTables(parse: Parse): { litCost: Float64Array; lenCost: Float64Array; distCost: Float64Array } {
  const freq = parseFreqs(parse);
  const litLen = huffmanLengths(freq.lit, 15);
  const distLen = huffmanLengths(freq.dist, 15);
  const litCost = new Float64Array(288);
  for (let s = 0; s < 288; s++) litCost[s] = litLen[s] === 0 ? 24 : litLen[s];
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = litCost[257 + LEN_CODE[l]] + LEN_COST_EXTRA[l];
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) {
    const dl = distLen[DIST_CODE[d]];
    distCost[d] = (dl === 0 ? 24 : dl) + DIST_COST_EXTRA[d];
  }
  return { litCost, lenCost, distCost };
}

/**
 * Estimated cost of the symbols that start at or after rowStart in buf,
 * from a cheap single-candidate hash matcher (most recent occurrence only).
 * Only used to rank filter candidates, so a rough LZ-aware figure suffices.
 */
function rowStreamCost(buf: Uint8Array, rowStart: number, t: { litCost: Float64Array; lenCost: Float64Array; distCost: Float64Array }): number {
  const n = buf.length;
  const head = new Int32Array(1 << 15).fill(-1);
  const hashAt = (p: number): number => (((buf[p] << 16) ^ (buf[p + 1] << 8) ^ buf[p + 2]) * 2654435761 >>> 17) & 0x7fff;
  let cost = 0;
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + 2 < n) {
      const h = hashAt(i);
      const cand = head[h];
      head[h] = i;
      if (cand >= 0 && i - cand <= 32768) {
        let l = 0;
        const maxL = Math.min(258, n - i);
        while (l < maxL && buf[cand + l] === buf[i + l]) l++;
        if (l >= 3) {
          bestLen = l;
          bestDist = i - cand;
        }
      }
    }
    if (bestLen >= 3) {
      if (i >= rowStart) cost += t.lenCost[bestLen] + t.distCost[bestDist];
      for (let k = i + 1; k < i + bestLen && k + 2 < n; k++) head[hashAt(k)] = k;
      i += bestLen;
    } else {
      if (i >= rowStart) cost += t.litCost[buf[i]];
      i += 1;
    }
  }
  return cost;
}

/**
 * Build a raw stream whose per-row filters are chosen greedily by estimated
 * LZ cost against the stream prefix chosen so far — the filter choice that
 * looks best to entropy alone is often not the one the LZ parse likes.
 */
function lzFilteredStream(form: Form, width: number, height: number, t: { litCost: Float64Array; lenCost: Float64Array; distCost: Float64Array }): Uint8Array {
  const stride = width * form.bpp;
  const rowLen = stride + 1;
  const out = new Uint8Array(height * rowLen);
  const rowBytes = new Uint8Array(stride);
  const CTX = 4096;
  for (let y = 0; y < height; y++) {
    const cur = form.samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : form.samples.subarray((y - 1) * stride, y * stride);
    let bestF = 0;
    let bestCost = Infinity;
    let bestRow: Uint8Array | null = null;
    for (let f = 0; f <= 4; f++) {
      filterRow(f, cur, prev, form.bpp, rowBytes);
      const ctxLen = Math.min(y * rowLen, CTX);
      const buf = new Uint8Array(ctxLen + rowLen);
      buf.set(out.subarray(y * rowLen - ctxLen, y * rowLen), 0);
      buf[ctxLen] = f;
      buf.set(rowBytes, ctxLen + 1);
      const cost = rowStreamCost(buf, ctxLen, t);
      if (cost < bestCost) {
        bestCost = cost;
        bestF = f;
        bestRow = new Uint8Array(rowBytes);
      }
    }
    out[y * rowLen] = bestF;
    out.set(bestRow as Uint8Array, y * rowLen + 1);
  }
  return out;
}

// ---------------------------------------------------------------- Driver

const SCREEN_OPTS = { level: 6 } as const;

/** Squeeze one RGBA image into the smallest PNG we can make. */
function squeeze(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const forms = formsOf(rgba);
  const screened: { form: Form; raw: Uint8Array; size: number }[] = [];
  for (const form of forms) {
    const choices: (number | string)[] = form.colourType === 3 ? [0, 'minsum', 'entropy'] : [0, 1, 2, 4, 'minsum', 'entropy'];
    for (const choice of choices) {
      const raw = filteredSamples(form.samples, width, height, form.bpp, choice);
      const z = deflateRawSync(raw, SCREEN_OPTS);
      screened.push({ form, raw, size: z.length + form.chunkBytes });
    }
  }
  screened.sort((a, b) => a.size - b.size);
  const winner = screened[0];
  for (let i = 1; i < screened.length; i++) screened[i].raw = new Uint8Array(0);
  // Candidate streams raced through the optimal compressor; smallest wins.
  const candidates: { form: Form; raw: Uint8Array; light: boolean }[] = [{ form: winner.form, raw: winner.raw, light: false }];
  if (winner.size >= 90000) {
    const tables = costTables(greedyParse(winner.raw, findMatches(winner.raw)));
    candidates.push({ form: winner.form, raw: lzFilteredStream(winner.form, width, height, tables), light: true });
  }
  let bestForm: Form | null = null;
  let bestPng: Uint8Array | null = null;
  let bestTotal = Infinity;
  for (const cand of candidates) {
    const stream = deflateBest(cand.raw, cand.light);
    const chunks: [string, Uint8Array][] = [['IHDR', ihdrOf(width, height, cand.form.colourType)]];
    if (cand.form.plte !== null) chunks.push(['PLTE', cand.form.plte]);
    if (cand.form.trns !== null) chunks.push(['tRNS', cand.form.trns]);
    chunks.push(['IDAT', stream]);
    chunks.push(['IEND', new Uint8Array(0)]);
    const png = pngOf(chunks);
    if (png.length < bestTotal) {
      bestTotal = png.length;
      bestForm = cand.form;
      bestPng = png;
    }
  }
  return bestPng as Uint8Array;
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
