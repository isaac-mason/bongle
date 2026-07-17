// lib/cli/decode-audio-node.ts — the node DecodeAudio impl, the sibling of
// src/asset-pipeline/decode-audio-browser.ts. node-web-audio-api ships a spec
// OfflineAudioContext whose decodeAudioData decodes wav/mp3/ogg/flac AND
// resamples to the context rate — so this is a near-verbatim mirror of the
// browser impl (which leans on the exact same WebAudio API).

import { OfflineAudioContext } from 'node-web-audio-api';
import type { DecodeAudio, DecodedAudio } from '../../src/asset-pipeline/bake/decode-audio';

export function createNodeDecodeAudio(): DecodeAudio {
    return async (bytes: Uint8Array, sampleRate: number): Promise<DecodedAudio> => {
        // decodeAudioData resamples to the context sampleRate; a 1-frame length is
        // fine (the decoded buffer carries the source's real length).
        const ctx = new OfflineAudioContext(1, 1, sampleRate);
        // hand it a detachable copy so the caller's bytes stay valid.
        const buffer = await ctx.decodeAudioData(bytes.slice().buffer);
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
