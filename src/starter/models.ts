// Starter pack model handles.
//
// Each `model()` call sources its gltf via `asset('./assets/…',
// import.meta.url)`, so the file ships alongside this module and resolves
// relative to it wherever the starter package is installed; the pipeline reads
// the resolved path.
//
// Exposed individually so the package index can re-export them as
// `export * as models`. Consumers reach them as `models.spark` etc.

import { asset, model } from 'bongle';

export const spark = model('starter:spark', {
    src: asset('./assets/models/spark.gltf', import.meta.url),
});
