// bake/opus.ts — encode a mono s16 PCM atlas to WebM-Opus. Lossy but ~4x smaller than
// FLAC on real SFX, and gapless enough for the atlas-offset scheme: the front pre-skip
// is trimmed by the OpusHead CodecDelay (so decoded audio aligns to sample 0), and the
// ragged tail is trailing silence PAST the last clip (nothing references it). Per-clip
// offsets stay time-accurate — the atlas decodes to the same interior sample positions.
//
// Codec = our own libopus wasm (lib/opus-wasm), container = mediabunny's WebMOutputFormat
// — both host-neutral (browser editor + node CLI), so this stays codec-owning like
// mp3.ts with no native FFmpeg and no WebCodecs.

import { BufferTarget, EncodedAudioPacketSource, EncodedPacket, Output, WebMOutputFormat } from 'mediabunny';
import { encodeOpusMono, initOpus, OPUS_FRAME_SIZE, OPUS_SAMPLE_RATE } from '../../../opus-wasm';

/** OpusHead — the WebM CodecPrivate. `preskip` here is what makes the decoder trim the
 *  encoder lookahead (via the derived Matroska CodecDelay), aligning audio to sample 0. */
function opusHead(preskip: number): Uint8Array {
    const b = new Uint8Array(19);
    b.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // 'OpusHead'
    b[8] = 1; // version
    b[9] = 1; // channels (mono)
    const dv = new DataView(b.buffer);
    dv.setUint16(10, preskip, true);
    dv.setUint32(12, OPUS_SAMPLE_RATE, true);
    return b;
}

/** Encode mono s16 PCM (already at OPUS_SAMPLE_RATE) → WebM-Opus bytes. */
export async function encodeOpusAtlasWebm(pcm: Int16Array, bitrate: number): Promise<Uint8Array> {
    await initOpus();
    const { packets, preskip, totalSamples } = encodeOpusMono(pcm, bitrate);

    const target = new BufferTarget();
    const output = new Output({ format: new WebMOutputFormat(), target });
    const source = new EncodedAudioPacketSource('opus');
    output.addAudioTrack(source);
    await output.start();

    const frameDur = OPUS_FRAME_SIZE / OPUS_SAMPLE_RATE;
    const meta = {
        decoderConfig: {
            codec: 'opus',
            sampleRate: OPUS_SAMPLE_RATE,
            numberOfChannels: 1,
            description: opusHead(preskip),
        },
    };
    for (let i = 0; i < packets.length; i++) {
        // shorten the last packet's duration to trim the padded tail toward exactly
        // `totalSamples` (front pre-skip is trimmed by CodecDelay from the OpusHead).
        const last = i === packets.length - 1;
        const dur = last ? (totalSamples + preskip - i * OPUS_FRAME_SIZE) / OPUS_SAMPLE_RATE : frameDur;
        // opus packets are all key frames; decode order == the emit order.
        await source.add(new EncodedPacket(packets[i]!, 'key', i * frameDur, dur), i === 0 ? meta : undefined);
    }
    await output.finalize();
    if (!target.buffer) throw new Error('[bongle] opus atlas mux produced no output');
    return new Uint8Array(target.buffer);
}
