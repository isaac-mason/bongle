// Starter pack model handles.
//
// Each `model()` call uses the URL form: `new URL('./assets/...',
// import.meta.url)` resolves to a bundled asset URL under vite, and to
// a `file://` path under bun (which the pipeline turns back into a disk
// path via fileURLToPath).
//
// Exposed individually so the package index can re-export them as
// `export * as models`. Consumers reach them as `models.spark` etc.

import { model } from 'bongle';

export const spark = model('starter:spark', {
    src: new URL('./assets/models/spark.gltf', import.meta.url),
});

export const peng = model('starter:peng', {
    src: new URL('./assets/models/peng.gltf', import.meta.url),
});
