// Host-injected audio decode capability (the audio analogue of the pipeline's
// injected `decodeImage`). Decoding compressed source audio is a browser job —
// `OfflineAudioContext.decodeAudioData` handles every format we accept
// (.wav/.mp3/.ogg/.flac) and resamples to the requested rate in one call — but
// it's main-thread only (no OfflineAudioContext in workers), so the pipeline
// worker reaches it through this injected function rather than owning it.
//
// The bake never encodes-source-to-source: it decodes to PCM here, then
// re-encodes (FLAC atlas / MP3 standalone). Returns per-channel s16 samples so
// the atlas can downmix to mono while standalone clips keep their stereo image.

export type DecodedAudio = {
    /** the rate the samples were resampled to (echoes the requested rate). */
    sampleRate: number;
    /** one Int16Array of s16 samples per channel (1 = mono, 2 = stereo). all
     *  channels are the same length. */
    channels: Int16Array[];
};

/** decode encoded audio bytes → per-channel s16 PCM resampled to `sampleRate`. */
export type DecodeAudio = (bytes: Uint8Array, sampleRate: number) => Promise<DecodedAudio>;
