// browser `DecodeAudio` impl for the pipeline (mediabunny + WebCodecs).
//
// The pipeline bakes in a Web Worker, where `OfflineAudioContext` (the obvious
// `decodeAudioData` path) is `[Exposed=Window]` and thus unavailable. mediabunny
// demuxes our source containers (wav/mp3/ogg/flac) and decodes through the
// worker-exposed WebCodecs `AudioDecoder`, and its conversion pipeline resamples
// to the atlas rate for us — so a single in-worker Conversion to an in-memory
// pcm-s16 WAV gives us exactly the per-channel PCM the atlas encoder wants, with
// no main-thread hop. (Sibling of the node impl, cli/bake/decode-audio-node.ts.)
//
// Non-PCM decoding rides the browser's WebCodecs, so it needs a Chromium-class
// engine — which the editor already requires (WebGPU, SAB, OffscreenCanvas).

import { ALL_FORMATS, BufferSource, BufferTarget, Conversion, Input, Output, WavOutputFormat } from 'mediabunny';
import type { DecodeAudio, DecodedAudio } from './bake/decode-audio';

export function createBrowserDecodeAudio(): DecodeAudio {
    return async (bytes: Uint8Array, sampleRate: number): Promise<DecodedAudio> => {
        // decode + resample to the target rate, re-encoded as an in-memory pcm-s16
        // WAV. sampleRate forces the resample; sampleFormat pins 16-bit; channels are
        // left unset so mono stays mono / stereo stays stereo (the atlas downmixes
        // itself, standalone clips keep their image).
        const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
        const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
        const conversion = await Conversion.init({ input, output, audio: { sampleRate, sampleFormat: 's16' } });
        if (!conversion.isValid) {
            const why = conversion.discardedTracks.map((t) => t.reason).join(', ') || 'no decodable audio track';
            throw new Error(`decodeAudio: cannot decode source (${why})`);
        }
        await conversion.execute();
        const buf = output.target.buffer;
        if (!buf) throw new Error('decodeAudio: conversion produced no output');
        return parseWavS16(new Uint8Array(buf));
    };
}

/** parse a canonical pcm-s16 RIFF/WAVE buffer into per-channel s16 samples. */
function parseWavS16(wav: Uint8Array): DecodedAudio {
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    if (tag(view, 0) !== 'RIFF' || tag(view, 8) !== 'WAVE') throw new Error('decodeAudio: not a WAV buffer');

    let channels = 1;
    let rate = 0;
    let bits = 16;
    let dataOffset = -1;
    let dataLen = 0;
    // walk the chunk list; chunks are word-aligned (odd sizes get a pad byte).
    for (let offset = 12; offset + 8 <= view.byteLength; ) {
        const id = tag(view, offset);
        const size = view.getUint32(offset + 4, true);
        const body = offset + 8;
        if (id === 'fmt ') {
            channels = view.getUint16(body + 2, true);
            rate = view.getUint32(body + 4, true);
            bits = view.getUint16(body + 14, true);
        } else if (id === 'data') {
            dataOffset = body;
            dataLen = size;
        }
        offset = body + size + (size & 1);
    }
    if (dataOffset < 0) throw new Error('decodeAudio: WAV has no data chunk');
    if (bits !== 16) throw new Error(`decodeAudio: expected s16 WAV, got ${bits}-bit`);

    const frames = Math.floor(dataLen / (2 * channels));
    const out: Int16Array[] = Array.from({ length: channels }, () => new Int16Array(frames));
    const pcm = new DataView(wav.buffer, wav.byteOffset + dataOffset, frames * channels * 2);
    for (let i = 0; i < frames; i++) {
        const base = i * channels;
        for (let c = 0; c < channels; c++) out[c]![i] = pcm.getInt16((base + c) * 2, true);
    }
    return { sampleRate: rate, channels: out };
}

function tag(view: DataView, off: number): string {
    return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
}
