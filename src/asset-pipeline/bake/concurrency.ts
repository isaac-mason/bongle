// bake/concurrency.ts — bounded fan-out for the bake's per-item work.
//
// The bake is a pile of independent per-item jobs (decode a clip, load a tile, parse a model)
// behind a few genuinely serial steps (rect packing, the one-stream Opus encode). Those jobs were
// `for (…) await …` loops, which is the one shape that guarantees no overlap at all: the injected
// capabilities the bake leans on — WebCodecs `AudioDecoder`, `createImageBitmap`, OffscreenCanvas
// `convertToBlob`, node's native canvas and fs — all hand the work off and return a promise, so
// awaiting them one at a time leaves the host idle between items.
//
// Bounded, not unbounded: 400 concurrent decodes means 400 live decoders and 400 open files, and
// the tail latency of the whole batch gets worse, not better.

/** at most this many jobs in flight per call site. Enough to keep the host's decode/encode
 *  pipelines fed without a batch large enough to thrash file handles or codec instances. */
export const BAKE_CONCURRENCY = 8;

/** Map `items` through `fn` with at most `limit` in flight. Results keep INPUT ORDER — the audio
 *  atlas concatenates PCM in registry order and derives each clip's offset from it, so a
 *  completion-ordered result would silently mis-time every clip. Rejects on the first failure
 *  (catch inside `fn` to skip an item instead). */
export async function mapConcurrent<T, R>(
    items: readonly T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const out = new Array<R>(items.length);
    let next = 0;
    const run = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i]!, i);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, run));
    return out;
}
