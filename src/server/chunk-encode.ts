// Node-native chunk compressor. This is the ONLY module that touches node:zlib,
// and it is imported solely by the server entry (engine-server), never by the
// public barrel — so the browser bundle never pulls a Node builtin. The codec
// itself (core/voxels/chunk-codec) takes this as an injected ChunkCompressor.

import { constants, zstdCompressSync } from 'node:zlib';
import type { ChunkCompressor } from '../core/voxels/chunk-codec';

// zstd level for chunk_full snapshots. level 6 encodes cheaper than the old
// deflate path with comparable size, and each snapshot is cached after the
// first build — raise it if egress matters more than server CPU. decode cost is
// essentially level-independent, so this only trades server CPU against bytes.
const CHUNK_ZSTD_LEVEL = 6;

/** Node-native zstd compressor for chunk_full payloads, injected into the codec
 *  via Discovery.init. */
export const compressChunkZstd: ChunkCompressor = (payload) =>
    zstdCompressSync(payload, {
        params: { [constants.ZSTD_c_compressionLevel]: CHUNK_ZSTD_LEVEL },
    });
