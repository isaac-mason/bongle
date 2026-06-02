// ── chunk codec ─────────────────────────────────────────────────────
//
// encoding pipeline for chunk_full messages:
//   1. interleave data + light into Uint16Array
//   2. RLE encode the Uint16Array
//   3. deflate compress via fflate
//
// decoding pipeline:
//   1. inflate decompress
//   2. RLE decode into Uint16Array
//   3. de-interleave into data + light
//
// interleaving groups correlated values together (air voxels have
// predictable light values), giving RLE much longer runs.
//
// the light-only codec (encodeLight/decodeLight, used by chunk_light)
// skips the deflate step — inflateSync was the dominant decode cost on
// the client, and RLE alone captures most of the win for low-entropy
// light data. see notes above encodeLight for the wire format.

import { CHUNK_VOLUME } from './voxels';
import { deflateSync, inflateSync } from 'fflate';

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

// ── interleave / de-interleave ──────────────────────────────────────

const INTERLEAVED_LENGTH = CHUNK_VOLUME * 2;

/** interleave data and light arrays into a single Uint16Array. */
export function interleave(data: Uint16Array, light: Uint16Array): Uint16Array {
    const out = new Uint16Array(INTERLEAVED_LENGTH);
    for (let i = 0; i < CHUNK_VOLUME; i++) {
        out[i * 2] = data[i]!;
        out[i * 2 + 1] = light[i]!;
    }
    return out;
}

/** de-interleave into separate data and light arrays. */
export function deinterleave(interleaved: Uint16Array): { data: Uint16Array; light: Uint16Array } {
    const data = new Uint16Array(CHUNK_VOLUME);
    const light = new Uint16Array(CHUNK_VOLUME);
    for (let i = 0; i < CHUNK_VOLUME; i++) {
        data[i] = interleaved[i * 2]!;
        light[i] = interleaved[i * 2 + 1]!;
    }
    return { data, light };
}

// ── compress / decompress ───────────────────────────────────────────

/** encode a chunk's data + light into compressed bytes. */
export function encodeChunk(data: Uint16Array, light: Uint16Array): Uint8Array {
    const interleaved = interleave(data, light);
    const rle = rleEncode(interleaved);
    // view the uint16 rle result as bytes for compression
    const bytes = new Uint8Array(rle.buffer, rle.byteOffset, rle.byteLength);
    return deflateSync(bytes);
}

/** decode compressed bytes back to data + light arrays. */
export function decodeChunk(compressed: Uint8Array): { data: Uint16Array; light: Uint16Array } {
    const bytes = inflateSync(compressed);
    // view the inflated bytes as uint16 pairs
    const rle = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const interleaved = rleDecode(rle, INTERLEAVED_LENGTH);
    return deinterleave(interleaved);
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
    // into a fresh buffer at an odd offset. fall back to a copied alignment
    // when needed; the common path hits the zero-copy branch.
    const skyRle = (skyBytes.byteOffset & 1) === 0
        ? new Uint16Array(skyBytes.buffer, skyBytes.byteOffset, skyBytes.byteLength >>> 1)
        : new Uint16Array(skyBytes.slice().buffer);
    const rgbRle = (rgbBytes.byteOffset & 1) === 0
        ? new Uint16Array(rgbBytes.buffer, rgbBytes.byteOffset, rgbBytes.byteLength >>> 1)
        : new Uint16Array(rgbBytes.slice().buffer);

    const light = new Uint16Array(CHUNK_VOLUME);

    // walk both RLE streams in lockstep. each iteration advances the channel
    // whose current run ends sooner, writing min(skyRun, rgbRun) packed
    // values before refilling the shorter run. no intermediate buffers.
    let si = 0;          // index into skyRle (pair-aligned, += 2 per refill)
    let ri = 0;          // index into rgbRle
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
