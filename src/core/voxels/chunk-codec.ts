import { zstdDecompress } from '../utils/fzstd';
import { CHUNK_VOLUME } from './voxels';

// run-length encoding for Uint16Array: pairs of (value, count). count is
// uint16, so max run length is 65535, always enough for a CHUNK_VOLUME stream.

/** rle encode a uint16 array. returns (value, count) pairs as Uint16Array. */
export function rleEncode(input: Uint16Array): Uint16Array {
    if (input.length === 0) return new Uint16Array(0);

    // worst case: every value is different, 2 * input.length pairs
    const pairs = new Uint16Array(input.length * 2);
    let pairCount = 0;

    let runValue = input[0]!;
    let runLength = 1;

    for (let i = 1; i < input.length; i++) {
        const v = input[i]!;
        if (v === runValue && runLength < 65535) {
            runLength++;
        } else {
            pairs[pairCount++] = runValue;
            pairs[pairCount++] = runLength;
            runValue = v;
            runLength = 1;
        }
    }

    // flush last run
    pairs[pairCount++] = runValue;
    pairs[pairCount++] = runLength;

    return pairs.subarray(0, pairCount);
}

// shared scratch buffer for the RLE call sites below, sized for one
// CHUNK_VOLUME-length stream's worst case (every element its own run), so
// rleEncodeScratch is a one-time allocation plus a right-sized copy instead of
// a fresh worst-case buffer per call.
const RLE_SCRATCH = new Uint16Array(CHUNK_VOLUME * 2);

/** rle encode via the shared scratch buffer, returning a right-sized copy.
 *  falls back to rleEncode() for input longer than CHUNK_VOLUME (shouldn't
 *  happen for chunk data/light/sky/rgb, all fixed at CHUNK_VOLUME). */
function rleEncodeScratch(input: Uint16Array): Uint16Array {
    if (input.length === 0) return new Uint16Array(0);
    if (input.length * 2 > RLE_SCRATCH.length) return rleEncode(input);

    let runValue = input[0]!;
    let runLength = 1;
    let pairCount = 0;

    for (let i = 1; i < input.length; i++) {
        const v = input[i]!;
        if (v === runValue && runLength < 65535) {
            runLength++;
        } else {
            RLE_SCRATCH[pairCount++] = runValue;
            RLE_SCRATCH[pairCount++] = runLength;
            runValue = v;
            runLength = 1;
        }
    }
    RLE_SCRATCH[pairCount++] = runValue;
    RLE_SCRATCH[pairCount++] = runLength;

    return RLE_SCRATCH.slice(0, pairCount);
}

/** rle decode (value, count) pairs back to a flat uint16 array. */
export function rleDecode(pairs: Uint16Array, outputLength: number): Uint16Array {
    const output = new Uint16Array(outputLength);
    let writeIdx = 0;

    for (let i = 0; i < pairs.length; i += 2) {
        const value = pairs[i]!;
        const count = pairs[i + 1]!;
        for (let j = 0; j < count; j++) {
            output[writeIdx++] = value;
        }
    }

    return output;
}

// 8-byte header before the two RLE streams: data byte length, light byte
// length (both uint32 LE). data starts at offset 8, light right after. both
// stream offsets are even so decode can view them as Uint16 without a copy.
const CHUNK_HEADER_BYTES = 8;

/** view a Uint16Array's used bytes (rleEncode returns a subarray view). */
function u16Bytes(arr: Uint16Array): Uint8Array {
    return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** reinterpret a byte slice as Uint16. zero-copy when 2-byte aligned,
 *  else falls back to a copied (aligned) buffer. */
function bytesAsU16(bytes: Uint8Array): Uint16Array {
    return (bytes.byteOffset & 1) === 0
        ? new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 1)
        : new Uint16Array(bytes.slice().buffer);
}

/** a zstd implementation, injected into encodeChunk so this browser-safe
 *  module never hard-depends on a particular zstd build. only `compress`
 *  today, the client decodes with fzstd. */
export type Zstd = { compress: (payload: Uint8Array, level: number) => Uint8Array };

// each snapshot is cached after the first build; raise this if egress matters
// more than server CPU (decode cost is essentially level-independent).
const CHUNK_ZSTD_LEVEL = 6;

/** pack a chunk's data + light into the pre-compression byte payload: two RLE
 *  streams under an 8-byte length header. kept as separate streams rather than
 *  interleaved so each channel's runs stay contiguous (measured 1.4-6x smaller
 *  on structured chunks than an interleaved stream). */
function packChunkStreams(data: Uint16Array, light: Uint16Array): Uint8Array {
    const dataBytes = u16Bytes(rleEncodeScratch(data));
    const lightBytes = u16Bytes(rleEncodeScratch(light));

    const concat = new Uint8Array(CHUNK_HEADER_BYTES + dataBytes.length + lightBytes.length);
    const header = new DataView(concat.buffer, 0, CHUNK_HEADER_BYTES);
    header.setUint32(0, dataBytes.length, true);
    header.setUint32(4, lightBytes.length, true);
    concat.set(dataBytes, CHUNK_HEADER_BYTES);
    concat.set(lightBytes, CHUNK_HEADER_BYTES + dataBytes.length);

    return concat;
}

/** encode a chunk's data + light into a chunk_full wire payload: RLE-pack, then
 *  zstd-compress via the injected `zstd` at the codec's chunk level. the client
 *  reverses this with decodeChunk. */
export function encodeChunk(data: Uint16Array, light: Uint16Array, zstd: Zstd): Uint8Array {
    return zstd.compress(packChunkStreams(data, light), CHUNK_ZSTD_LEVEL);
}

/** decode zstd-compressed chunk bytes back to data + light arrays. */
export function decodeChunk(compressed: Uint8Array): { data: Uint16Array; light: Uint16Array } {
    const raw = zstdDecompress(compressed);
    const header = new DataView(raw.buffer, raw.byteOffset, CHUNK_HEADER_BYTES);
    const dataLen = header.getUint32(0, true);
    const lightLen = header.getUint32(4, true);

    const dataStart = CHUNK_HEADER_BYTES;
    const lightStart = dataStart + dataLen;
    const data = rleDecode(bytesAsU16(raw.subarray(dataStart, lightStart)), CHUNK_VOLUME);
    const light = rleDecode(bytesAsU16(raw.subarray(lightStart, lightStart + lightLen)), CHUNK_VOLUME);

    return { data, light };
}

// chunk_light payloads split the packed (sky << 12) | rgb value into two
// streams before RLE: sky and rgb run under very different distributions
// (sky correlates with the heightmap, rgb is mostly zero), so a combined RLE
// would break a run whenever either channel changes. no zstd here: RLE alone
// captures most of the win for low-entropy light data.

/** view a Uint16Array's underlying bytes, typically the result of rleEncode
 *  ready to send on the wire as a uint8Array pack field. */
function uint16AsBytes(arr: Uint16Array): Uint8Array {
    return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

/** encode a chunk's light array. splits sky (4 bits) and rgb (12 bits) into
 *  two streams and RLE each. wire bytes are the uint16 RLE pairs as-is. */
export function encodeLight(light: Uint16Array): { sky: Uint8Array; rgb: Uint8Array } {
    const sky = new Uint16Array(light.length);
    const rgb = new Uint16Array(light.length);
    for (let i = 0; i < light.length; i++) {
        const v = light[i]!;
        sky[i] = (v >>> 12) & 0xf;
        rgb[i] = v & 0xfff;
    }
    return {
        sky: uint16AsBytes(rleEncodeScratch(sky)),
        rgb: uint16AsBytes(rleEncodeScratch(rgb)),
    };
}

/** decode the two RLE'd byte streams back into a packed light array. fuses
 *  rleDecode + sky/rgb merge into a single pass that writes directly into the
 *  final Uint16Array, skipping the intermediate per-channel decode buffers. */
export function decodeLight(skyBytes: Uint8Array, rgbBytes: Uint8Array): Uint16Array {
    // wire bytes may be misaligned for a Uint16Array view if pack copied them
    // into a fresh buffer at an odd offset; bytesAsU16 falls back to a copy.
    const skyRle = bytesAsU16(skyBytes);
    const rgbRle = bytesAsU16(rgbBytes);

    const light = new Uint16Array(CHUNK_VOLUME);

    // walk both RLE streams in lockstep. each iteration advances the channel
    // whose current run ends sooner, writing min(skyRun, rgbRun) packed
    // values before refilling the shorter run. no intermediate buffers.
    let si = 0; // index into skyRle (pair-aligned, += 2 per refill)
    let ri = 0; // index into rgbRle
    let skyVal = skyRle[0]! << 12;
    let skyLeft = skyRle[1]!;
    let rgbVal = rgbRle[0]!;
    let rgbLeft = rgbRle[1]!;
    let w = 0;

    while (w < CHUNK_VOLUME) {
        const n = skyLeft < rgbLeft ? skyLeft : rgbLeft;
        const packed = skyVal | rgbVal;
        const end = w + n;
        for (let i = w; i < end; i++) light[i] = packed;
        w = end;
        skyLeft -= n;
        rgbLeft -= n;
        if (skyLeft === 0 && w < CHUNK_VOLUME) {
            si += 2;
            skyVal = skyRle[si]! << 12;
            skyLeft = skyRle[si + 1]!;
        }
        if (rgbLeft === 0 && w < CHUNK_VOLUME) {
            ri += 2;
            rgbVal = rgbRle[ri]!;
            rgbLeft = rgbRle[ri + 1]!;
        }
    }

    return light;
}
