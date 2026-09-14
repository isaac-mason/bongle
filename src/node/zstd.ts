import { constants, zstdCompressSync } from 'node:zlib';
import type { Zstd } from '../core/voxels/chunk-codec';

/** Node-native zstd impl, injected into the codec via EngineServer.init.
 *  Normalizes the positional `level` onto node:zlib's params-object API so the
 *  compress shape matches zstd-wasm's `(payload, level)`. */
export const nodeZstd: Zstd = {
    compress: (payload, level) =>
        zstdCompressSync(payload, {
            params: { [constants.ZSTD_c_compressionLevel]: level },
        }),
};
