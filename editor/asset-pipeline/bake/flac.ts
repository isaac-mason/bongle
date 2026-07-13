// Minimal, spec-valid FLAC encoder (mono, 16-bit). Roll-our-own: fixed linear
// predictors (orders 0-4) + partition-order-0 Rice coding — the compressible
// core of FLAC without the expensive LPC search libFLAC does. Output is
// standard native FLAC (`fLaC` + STREAMINFO + frames), so the browser decodes
// it via decodeAudioData with zero client changes. Lossless + gapless: decode
// returns the EXACT input sample count, so atlas offsets stay sample-aligned.
//
// Deliberately simple choices, each noted: single Rice partition, always the
// 16-bit blocksize escape in the frame header, cost-based pick between
// CONSTANT / VERBATIM / FIXED so we never emit a pathologically large frame.
//
// Validated bit-exact + stream-valid against the reference `flac` decoder
// (encode -> `flac -d` -> compare; `flac -st` integrity) across sine / silence
// / full-scale / noise / ramp / multi-block-with-ragged-tail signals.

const BLOCK = 4096;
const BPS = 16;

// ── CRCs ────────────────────────────────────────────────────────────
// FLAC uses CRC-8 (poly 0x07) over each frame header and CRC-16 (poly 0x8005)
// over each whole frame. Both over byte-aligned data.

function crc8(bytes: number[], end: number): number {
    let crc = 0;
    for (let i = 0; i < end; i++) {
        crc ^= bytes[i]!;
        for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
    return crc;
}

function crc16(bytes: number[], end: number): number {
    let crc = 0;
    for (let i = 0; i < end; i++) {
        crc ^= bytes[i]! << 8;
        for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
}

// ── bit writer (MSB-first) ──────────────────────────────────────────

class BitWriter {
    bytes: number[] = [];
    private cur = 0;
    private nbits = 0;

    bit(b: number): void {
        this.cur = (this.cur << 1) | (b & 1);
        if (++this.nbits === 8) {
            this.bytes.push(this.cur);
            this.cur = 0;
            this.nbits = 0;
        }
    }
    /** write the low `n` bits of `value` (n ≤ 32), MSB first. */
    bits(value: number, n: number): void {
        for (let i = n - 1; i >= 0; i--) this.bit((value >>> i) & 1);
    }
    /** `q` zero bits then a 1 stop bit (FLAC unary). */
    unary(q: number): void {
        for (let i = 0; i < q; i++) this.bit(0);
        this.bit(1);
    }
    /** signed `v` in `n` bits, two's complement. */
    signed(v: number, n: number): void {
        this.bits(v & (n === 32 ? 0xffffffff : (1 << n) - 1), n);
    }
    align(): void {
        while (this.nbits !== 0) this.bit(0);
    }
    /** valid only when byte-aligned. */
    get length(): number {
        return this.bytes.length;
    }
}

// FLAC's UTF-8-like coded number (frame number for fixed blocking).
function writeUtf8(bw: BitWriter, val: number): void {
    if (val < 0x80) {
        bw.bits(val, 8);
        return;
    }
    let bytesN: number;
    if (val < 0x800) bytesN = 2;
    else if (val < 0x10000) bytesN = 3;
    else if (val < 0x200000) bytesN = 4;
    else if (val < 0x4000000) bytesN = 5;
    else bytesN = 6;
    const lead = (0xff << (8 - bytesN)) & 0xff;
    bw.bits(lead | (val >>> ((bytesN - 1) * 6)), 8);
    for (let i = bytesN - 2; i >= 0; i--) bw.bits(0x80 | ((val >>> (i * 6)) & 0x3f), 8);
}

// ── fixed predictors + residual ─────────────────────────────────────

function residualsFor(x: Int32Array, order: number): Int32Array {
    const n = x.length;
    const res = new Int32Array(n - order);
    for (let i = order; i < n; i++) {
        let p = 0;
        switch (order) {
            case 1:
                p = x[i - 1]!;
                break;
            case 2:
                p = 2 * x[i - 1]! - x[i - 2]!;
                break;
            case 3:
                p = 3 * x[i - 1]! - 3 * x[i - 2]! + x[i - 3]!;
                break;
            case 4:
                p = 4 * x[i - 1]! - 6 * x[i - 2]! + 4 * x[i - 3]! - x[i - 4]!;
                break;
        }
        res[i - order] = x[i]! - p;
    }
    return res;
}

/** best Rice parameter (0-14) + bit cost for a residual run, single partition. */
function bestRice(res: Int32Array): { k: number; bits: number } {
    let best = { k: 0, bits: Number.POSITIVE_INFINITY };
    for (let k = 0; k <= 14; k++) {
        let bits = 0;
        for (let i = 0; i < res.length; i++) {
            const v = res[i]!;
            const u = v >= 0 ? v * 2 : -v * 2 - 1; // zigzag
            bits += (u >>> k) + 1 + k;
            if (bits >= best.bits) break; // early out
        }
        if (bits < best.bits) best = { k, bits };
    }
    return best;
}

function writeRiceResidual(bw: BitWriter, res: Int32Array, k: number): void {
    bw.bits(0b00, 2); // residual method: 4-bit Rice params
    bw.bits(0, 4); // partition order 0 → single partition
    bw.bits(k, 4);
    const mask = k === 0 ? 0 : (1 << k) - 1;
    for (let i = 0; i < res.length; i++) {
        const v = res[i]!;
        const u = v >= 0 ? v * 2 : -v * 2 - 1;
        bw.unary(u >>> k);
        if (k > 0) bw.bits(u & mask, k);
    }
}

// ── subframe ────────────────────────────────────────────────────────

function encodeSubframe(bw: BitWriter, x: Int32Array): void {
    const n = x.length;

    // CONSTANT?
    let constant = true;
    for (let i = 1; i < n; i++)
        if (x[i] !== x[0]) {
            constant = false;
            break;
        }
    if (constant) {
        bw.bit(0);
        bw.bits(0b000000, 6);
        bw.bit(0); // header: pad, type CONSTANT, no wasted bits
        bw.signed(x[0]!, BPS);
        return;
    }

    // pick cheapest of fixed orders 0-4 (cost = warmup + rice), vs verbatim.
    const verbatimCost = n * BPS;
    let bestOrder = -1;
    let bestBits = verbatimCost;
    let bestK = 0;
    const maxOrder = Math.min(4, n - 1);
    for (let o = 0; o <= maxOrder; o++) {
        const res = residualsFor(x, o);
        const { k, bits } = bestRice(res);
        const cost = o * BPS + 2 + 4 + 4 + bits; // warmup + method + partorder + param + rice
        if (cost < bestBits) {
            bestBits = cost;
            bestOrder = o;
            bestK = k;
        }
    }

    if (bestOrder < 0) {
        // VERBATIM fallback
        bw.bit(0);
        bw.bits(0b000001, 6);
        bw.bit(0);
        for (let i = 0; i < n; i++) bw.signed(x[i]!, BPS);
        return;
    }

    // FIXED order `bestOrder`
    bw.bit(0);
    bw.bits(0b001000 | bestOrder, 6);
    bw.bit(0);
    for (let i = 0; i < bestOrder; i++) bw.signed(x[i]!, BPS); // warmup
    writeRiceResidual(bw, residualsFor(x, bestOrder), bestK);
}

// ── frame ───────────────────────────────────────────────────────────

function encodeFrame(x: Int32Array, frameNumber: number): number[] {
    const bw = new BitWriter();
    // header
    bw.bits(0x3ffe, 14); // sync
    bw.bit(0); // reserved
    bw.bit(0); // blocking strategy: fixed
    bw.bits(0b0111, 4); // block size: 16-bit (blocksize-1) at header end
    bw.bits(0b1010, 4); // sample rate: 48000
    bw.bits(0b0000, 4); // channel assignment: mono
    bw.bits(0b100, 3); // sample size: 16 bits
    bw.bit(0); // reserved
    writeUtf8(bw, frameNumber);
    bw.bits(x.length - 1, 16); // blocksize-1 (escape from block-size bits 0111)
    // header is byte-aligned here → CRC-8 over it
    bw.bits(crc8(bw.bytes, bw.length), 8);

    encodeSubframe(bw, x);
    bw.align();
    bw.bits(crc16(bw.bytes, bw.length), 16);
    return bw.bytes;
}

// ── stream ──────────────────────────────────────────────────────────

export function encodeFlacMono(samples: Int16Array, sampleRate: number): Uint8Array {
    const total = samples.length;
    const frames = Math.max(1, Math.ceil(total / BLOCK));
    const lastLen = total - (frames - 1) * BLOCK || BLOCK;
    const minBlock = frames === 1 ? total : Math.min(BLOCK, lastLen);

    // ── STREAMINFO (metadata block header + 34-byte body) ──
    const si = new BitWriter();
    si.bit(1); // last metadata block
    si.bits(0, 7); // type STREAMINFO
    si.bits(34, 24); // length
    si.bits(minBlock, 16);
    si.bits(BLOCK, 16);
    si.bits(0, 24); // min frame size (unknown)
    si.bits(0, 24); // max frame size (unknown)
    si.bits(sampleRate, 20);
    si.bits(0, 3); // channels - 1
    si.bits(BPS - 1, 5);
    si.bits(0, 4); // total samples high 4 bits (total < 2^32)
    si.bits(total >>> 0, 32); // total samples low 32
    for (let i = 0; i < 16; i++) si.bits(0, 8); // MD5 = unknown
    si.align();

    const chunks: number[][] = [[0x66, 0x4c, 0x61, 0x43], si.bytes]; // 'fLaC'
    for (let f = 0; f < frames; f++) {
        const start = f * BLOCK;
        const len = f === frames - 1 ? total - start : BLOCK;
        const x = new Int32Array(len);
        for (let i = 0; i < len; i++) x[i] = samples[start + i]!;
        chunks.push(encodeFrame(x, f));
    }

    let size = 0;
    for (const c of chunks) size += c.length;
    const out = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) {
        out.set(c, o);
        o += c.length;
    }
    return out;
}
