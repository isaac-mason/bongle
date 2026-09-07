// lib/opus-wasm — mono/48k Opus ENCODER for the audio-atlas bake (browser editor +
// node CLI). Our own tiny emscripten build (src/wrapper.c → dist/opus.mjs, committed)
// so there's no native FFmpeg or WebCodecs dependency and bakes are deterministic. One
// wasm for both hosts; the client decodes natively via decodeAudioData (WebM-Opus).

// @ts-expect-error — committed emscripten build, no bundled types.
import createOpusModule from './dist/opus.mjs';

type OpusModule = {
    _malloc(n: number): number;
    _free(p: number): void;
    /** create a mono/48k VBR encoder at `bitrate` and `complexity`; returns the pre-skip (lookahead) or -1. */
    _oe_init(bitrate: number, complexity: number): number;
    /** encode one frame; returns the packet byte length (>=0) or a negative error. */
    _oe_encode(pcmPtr: number, frameSize: number, outPtr: number, cap: number): number;
    _oe_free(): void;
    HEAPU8: Uint8Array;
    HEAP16: Int16Array;
};

/** 20ms mono frame @ 48k — Opus's standard frame size. (60ms frames measured ~0.5%
 *  smaller on SFX: not worth a format change.) */
export const OPUS_FRAME_SIZE = 960;
export const OPUS_SAMPLE_RATE = 48000;

export type OpusEncoded = {
    /** raw Opus packets, one per frame, in order — hand to the container muxer. */
    packets: Uint8Array[];
    /** encoder lookahead in samples; goes in the WebM/OpusHead CodecPrivate so the
     *  decoder trims it (→ decoded length is exactly `totalSamples`). */
    preskip: number;
    /** the original (untrimmed) mono sample count, for the container's end-trim. */
    totalSamples: number;
    frameSize: number;
    sampleRate: number;
};

let mod: OpusModule | null = null;

/** Load the wasm module (once). Await before `encodeOpusMono`. */
export async function initOpus(): Promise<void> {
    if (!mod) mod = (await createOpusModule()) as OpusModule;
}

/** Encode mono s16 PCM (already at 48kHz) to Opus packets. Pads the tail so the
 *  container's end-trim decodes back to exactly `pcm.length` samples — keeping the
 *  atlas's per-clip offsets sample-accurate. Requires `initOpus()` first. */
export function encodeOpusMono(pcm: Int16Array, bitrate: number, complexity: number): OpusEncoded {
    const m = mod;
    if (!m) throw new Error('[opus-wasm] not initialized — await initOpus() first');
    const preskip = m._oe_init(bitrate, complexity);
    if (preskip < 0) throw new Error('[opus-wasm] encoder init failed');

    const N = pcm.length;
    // encode enough frames that total encoded samples >= N + preskip, so the decoder's
    // front pre-skip trim + tail granule trim leave exactly N samples.
    const totalFrames = Math.ceil((N + preskip) / OPUS_FRAME_SIZE);
    const inPtr = m._malloc(OPUS_FRAME_SIZE * 2);
    const CAP = 4000; // max Opus packet for one 20ms frame is well under this
    const outPtr = m._malloc(CAP);
    const frame = new Int16Array(OPUS_FRAME_SIZE);
    const packets: Uint8Array[] = [];
    try {
        for (let f = 0; f < totalFrames; f++) {
            const start = f * OPUS_FRAME_SIZE;
            const n = Math.max(0, Math.min(OPUS_FRAME_SIZE, N - start));
            if (n < OPUS_FRAME_SIZE) frame.fill(0); // zero-pad the ragged tail
            if (n > 0) frame.set(pcm.subarray(start, start + n));
            // re-read HEAP16 each iteration — it can move under memory growth (no growth
            // happens inside the loop since we don't malloc here, but stay honest).
            m.HEAP16.set(frame, inPtr >> 1);
            const len = m._oe_encode(inPtr, OPUS_FRAME_SIZE, outPtr, CAP);
            if (len < 0) throw new Error(`[opus-wasm] encode failed (${len})`);
            packets.push(m.HEAPU8.slice(outPtr, outPtr + len));
        }
    } finally {
        m._free(inPtr);
        m._free(outPtr);
        m._oe_free();
    }
    return { packets, preskip, totalSamples: N, frameSize: OPUS_FRAME_SIZE, sampleRate: OPUS_SAMPLE_RATE };
}
