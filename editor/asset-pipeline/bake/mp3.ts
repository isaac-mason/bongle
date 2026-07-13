// MP3 encode via lamejs (pure-JS libmp3lame port, ~45KB gz). Used only for the
// standalone `long:true` clips: they're played from offset 0, so MP3's encoder
// delay is a non-issue, and they need real lossy compression (a several-minute
// track as lossless FLAC would be MBs). The short-SFX atlas does NOT use this —
// it needs sample-exact gapless offsets, which lamejs can't emit (its
// Mp3Encoder writes no LAME gapless header), so the atlas is FLAC instead.

import { Mp3Encoder } from '@breezystack/lamejs';

const MP3_BLOCK = 1152; // one MPEG-1 Layer III frame

/** encode per-channel s16 PCM → MP3 bytes at `kbps`. 1 channel → mono, 2 →
 *  stereo (channels must be equal length). */
export function encodeMp3(channels: Int16Array[], sampleRate: number, kbps: number): Uint8Array {
    const numChannels = channels.length === 2 ? 2 : 1;
    const left = channels[0]!;
    const right = numChannels === 2 ? channels[1]! : null;

    const encoder = new Mp3Encoder(numChannels, sampleRate, kbps);
    const parts: Uint8Array[] = [];
    for (let i = 0; i < left.length; i += MP3_BLOCK) {
        const l = left.subarray(i, i + MP3_BLOCK);
        const buf = right ? encoder.encodeBuffer(l, right.subarray(i, i + MP3_BLOCK)) : encoder.encodeBuffer(l);
        if (buf.length) parts.push(buf);
    }
    const tail = encoder.flush();
    if (tail.length) parts.push(tail);

    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}
