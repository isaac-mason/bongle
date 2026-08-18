// lib/opus-wasm — mono/48k Opus ENCODER for the browser (editor) + node bake. Encode
// only: the client decodes natively via decodeAudioData (WebM-Opus). Per-frame API so
// index.ts drives the loop and owns the WebM muxing.
#include <opus.h>
#include <stdlib.h>

static OpusEncoder *g_enc = 0;

// create a mono 48k VBR encoder at `bitrate` bps. returns the encoder lookahead
// (pre-skip, in samples) or -1 on failure.
int oe_init(int bitrate) {
    int err;
    if (g_enc) { opus_encoder_destroy(g_enc); g_enc = 0; }
    g_enc = opus_encoder_create(48000, 1, OPUS_APPLICATION_AUDIO, &err);
    if (err != OPUS_OK || !g_enc) return -1;
    opus_encoder_ctl(g_enc, OPUS_SET_BITRATE(bitrate));
    opus_encoder_ctl(g_enc, OPUS_SET_VBR(1));
    int lookahead = 0;
    opus_encoder_ctl(g_enc, OPUS_GET_LOOKAHEAD(&lookahead));
    return lookahead;
}

// encode one frame of `frame_size` mono s16 samples at `pcm` into `out` (cap bytes).
// returns the opus packet length (>=0) or a negative opus error.
int oe_encode(const short *pcm, int frame_size, unsigned char *out, int cap) {
    if (!g_enc) return -2;
    return opus_encode(g_enc, pcm, frame_size, out, cap);
}

void oe_free(void) { if (g_enc) { opus_encoder_destroy(g_enc); g_enc = 0; } }
