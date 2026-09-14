/** enough to keep the host's decode/encode pipelines fed without thrashing file handles or codec instances. */
export const BAKE_CONCURRENCY = 8;

/** results keep input order: the audio atlas concatenates PCM in registry order and derives each
 *  clip's offset from it, so a completion-ordered result would silently mis-time every clip.
 *  rejects on the first failure (catch inside `fn` to skip an item instead). */
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
