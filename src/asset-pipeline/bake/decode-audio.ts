export type DecodedAudio = {
    /** the rate the samples were resampled to (echoes the requested rate). */
    sampleRate: number;
    /** one Int16Array of s16 samples per channel (1 = mono, 2 = stereo). all
     *  channels are the same length. */
    channels: Int16Array[];
};

/** decode encoded audio bytes → per-channel s16 PCM resampled to `sampleRate`. */
export type DecodeAudio = (bytes: Uint8Array, sampleRate: number) => Promise<DecodedAudio>;
