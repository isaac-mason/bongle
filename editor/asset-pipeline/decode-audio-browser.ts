// browser `DecodeAudio` impl for the pipeline (OfflineAudioContext).
//
// decodeAudioData handles every source format we accept (wav/mp3/ogg/flac) and
// resamples to the context's rate in one call. Main-thread only (no
// OfflineAudioContext in workers) — when the pipeline runs in a worker, the
// worker calls back to the main thread through this injected function.

import type { DecodeAudio, DecodedAudio } from './bake/decode-audio';

export function createBrowserDecodeAudio(): DecodeAudio {
    return async (bytes: Uint8Array, sampleRate: number): Promise<DecodedAudio> => {
        // decodeAudioData resamples to the context sampleRate. A 1-frame length
        // is fine; the decoded buffer carries the source's real length.
        const ctx = new OfflineAudioContext(1, 1, sampleRate);
        // decodeAudioData wants an ArrayBuffer it can detach; hand it a copy so
        // the caller's Uint8Array stays valid.
        const copy = bytes.slice().buffer;
        const buffer = await ctx.decodeAudioData(copy);

        const channels: Int16Array[] = [];
        for (let c = 0; c < buffer.numberOfChannels; c++) {
            const f32 = buffer.getChannelData(c);
            const s16 = new Int16Array(f32.length);
            for (let i = 0; i < f32.length; i++) {
                const v = Math.max(-1, Math.min(1, f32[i]!));
                s16[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
            }
            channels.push(s16);
        }
        return { sampleRate: buffer.sampleRate, channels };
    };
}
