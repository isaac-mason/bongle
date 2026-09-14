import { asset, model } from 'bongle';

export const spark = model('kit:spark', {
    src: asset('./assets/models/spark.gltf', import.meta.url),
});
