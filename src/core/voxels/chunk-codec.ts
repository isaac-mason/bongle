// ── chunk codec ─────────────────────────────────────────────────────
//
// encoding pipeline for chunk_full messages:
//   1. RLE encode data and light as two SEPARATE Uint16 streams
//   2. concat them under a small length header (data bytes, light bytes)
//   3. deflate the concatenation via fflate
//
// decoding pipeline:
//   1. inflate decompress
//   2. read the header, RLE decode each stream back into data / light
//
// data and light are kept as separate streams rather than interleaved:
// interleaving alternates two unrelated value distributions, which
// shortens every RLE run and gives deflate a noisier window. encoding
// each channel's runs contiguously is both smaller (measured 1.4–6× on
// structured chunks) and faster to decode (one smaller inflate, no
// de-interleave pass). RLE before deflate still earns its keep — it
// pre-collapses the long air/sky runs so deflate's window isn't spent on
// them. see chunk-codec-bench.ts for the variant comparison.
//
// the light-only codec (encodeLight/decodeLight, used by chunk_light)
// skips the deflate step — inflateSync was the dominant decode cost on
// the client, and RLE alone captures most of the win for low-entropy
// light data. see notes above encodeLight for the wire format.

import { deflateSync, inflateSync } from 'fflate';
import { CHUNK_VOLUME } from './voxels';

// ── RLE ─────────────────────────────────────────────────────────────
//
// run-length encoding for Uint16Array. output is pairs of (value, count).
// count is also uint16, so max run length is 65535. for chunks of 8192
// elements (4096 data + 4096 light interleaved), this is always enough.

/** rle encode a uint16 array. returns (value, count) pairs as Uint16Array. */
export function rleEncode(input: Uint16Array): Uint16Array {
    if (input.length === 0) return new Uint16Array(0);

    // worst case: every value is different → 2 * input.length pairs
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

// ── compress / decompress ───────────────────────────────────────────

// 8-byte header before the two RLE streams: data byte length, light byte
// length (both uint32 LE). data starts at offset 8, light right after.
// both stream offsets are even (header is 8 bytes, RLE streams are an
// even number of bytes) so decode can view them as Uint16 without a copy.
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

/** encode a chunk's data + light into compressed bytes. */
export function encodeChunk(data: Uint16Array, light: Uint16Array): Uint8Array {
    const dataBytes = u16Bytes(rleEncode(data));
    const lightBytes = u16Bytes(rleEncode(light));

    const concat = new Uint8Array(CHUNK_HEADER_BYTES + dataBytes.length + lightBytes.length);
    const header = new DataView(concat.buffer, 0, CHUNK_HEADER_BYTES);
    header.setUint32(0, dataBytes.length, true);
    header.setUint32(4, lightBytes.length, true);
    concat.set(dataBytes, CHUNK_HEADER_BYTES);
    concat.set(lightBytes, CHUNK_HEADER_BYTES + dataBytes.length);

    return deflateSync(concat);
}

/** decode compressed bytes back to data + light arrays. */
export function decodeChunk(compressed: Uint8Array): { data: Uint16Array; light: Uint16Array } {
    const raw = inflateSync(compressed);
    const header = new DataView(raw.buffer, raw.byteOffset, CHUNK_HEADER_BYTES);
    const dataLen = header.getUint32(0, true);
    const lightLen = header.getUint32(4, true);

    const dataStart = CHUNK_HEADER_BYTES;
    const lightStart = dataStart + dataLen;
    const data = rleDecode(bytesAsU16(raw.subarray(dataStart, lightStart)), CHUNK_VOLUME);
    const light = rleDecode(bytesAsU16(raw.subarray(lightStart, lightStart + lightLen)), CHUNK_VOLUME);

    return { data, light };
}

// ── light codec ─────────────────────────────────────────────────────
//
// chunk_light payloads split the packed (sky << 12) | rgb light value into
// two streams before RLE. sky and rgb run under very different distributions —
// sky correlates with the heightmap (long horizontal runs of 15 above terrain,
// 0 below), rgb is mostly zero except near emitters. a combined-uint16 RLE
// breaks runs whenever either channel changes; the split keeps each channel's
// natural run structure intact.
//
// no deflate. light entropy is low enough that RLE alone captures the bulk of
// the compression win, and inflateSync is the dominant cost on the decode
// side. wire format is rleEncode'd Uint16Array reinterpreted as bytes.

/** view a Uint16Array's underlying bytes — typically the result of rleEncode
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
        sky: uint16AsBytes(rleEncode(sky)),
        rgb: uint16AsBytes(rleEncode(rgb)),
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
