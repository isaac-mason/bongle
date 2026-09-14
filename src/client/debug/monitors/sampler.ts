/** fixed-size ring buffer for realtime watching; push() overwrites the oldest sample once full. */
export type Sampler = {
    readonly size: number;
    /** number of valid samples (grows to `size`, then stays). */
    readonly count: number;
    push(v: number): void;
    /** the i-th sample in chronological order (0 = oldest in view). */
    at(i: number): number;
    /** the most recent sample. */
    last(): number;
    min(): number;
    max(): number;
    avg(): number;
    /** drop all samples (e.g. on a scene change / new run). */
    clear(): void;
};

export function sampler(size: number): Sampler {
    const buf = new Array<number>(size).fill(0);
    let head = 0; // next write index
    let count = 0;

    const at = (i: number) => buf[(head - count + i + size * 2) % size];

    return {
        size,
        get count() {
            return count;
        },
        push(v) {
            buf[head] = v;
            head = (head + 1) % size;
            if (count < size) count++;
        },
        at,
        last() {
            return count ? at(count - 1) : 0;
        },
        min() {
            let m = Infinity;
            for (let i = 0; i < count; i++) m = Math.min(m, at(i));
            return count ? m : 0;
        },
        max() {
            let m = -Infinity;
            for (let i = 0; i < count; i++) m = Math.max(m, at(i));
            return count ? m : 0;
        },
        avg() {
            let s = 0;
            for (let i = 0; i < count; i++) s += at(i);
            return count ? s / count : 0;
        },
        clear() {
            head = 0;
            count = 0;
        },
    };
}

/** exponential moving average; `smooth` is the weight kept from history (0 = passthrough, 0.8 = heavy). Returns a stateful function. */
export function smoother(smooth = 0): (v: number) => number {
    const k = Math.max(0, Math.min(0.98, smooth));
    if (k === 0) return (v) => v;
    let s: number | undefined;
    return (v) => {
        s = s === undefined ? v : s * k + v * (1 - k);
        return s;
    };
}

/** autoscaled [lo, hi] range for a set of samplers, honoring fixed `min`/`max` overrides. A zero-height range is nudged so drawing math never divides by zero. */
export function autorange(samplers: Sampler[], min?: number, max?: number): [number, number] {
    let lo = min ?? Infinity;
    let hi = max ?? -Infinity;
    if (min === undefined || max === undefined) {
        for (const s of samplers) {
            for (let i = 0; i < s.count; i++) {
                const v = s.at(i);
                if (min === undefined) lo = Math.min(lo, v);
                if (max === undefined) hi = Math.max(hi, v);
            }
        }
    }
    if (!Number.isFinite(lo)) lo = 0;
    if (!Number.isFinite(hi)) hi = lo + 1;
    if (!(hi > lo)) hi = lo + 1;
    return [lo, hi];
}
