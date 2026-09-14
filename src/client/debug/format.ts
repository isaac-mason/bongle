// value formatters for monitors & graphs. the built-ins auto-scale magnitude so
// a metrics dashboard reads naturally: 1.4 GB, 12.4 ms, 1.2K, 58 fps.

export type Formatter = (value: number) => string;

// ~3 significant figures, scaled by magnitude
function sig(n: number): string {
    if (!Number.isFinite(n)) return String(n);
    const a = Math.abs(n);
    return n.toFixed(a >= 100 ? 0 : a >= 1 ? 1 : 2);
}

/** bytes → B / KB / MB / GB … (1024-based). */
export const bytes: Formatter = (v) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let n = v;
    let i = 0;
    while (Math.abs(n) >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${i === 0 ? Math.round(n) : sig(n)} ${units[i]}`;
};

/** milliseconds → ns / µs / ms / s. */
export const duration: Formatter = (ms) => {
    const a = Math.abs(ms);
    if (a === 0) return '0 ms';
    if (a < 0.001) return `${sig(ms * 1e6)} ns`;
    if (a < 1) return `${sig(ms * 1000)} µs`;
    if (a < 1000) return `${sig(ms)} ms`;
    return `${sig(ms / 1000)} s`;
};

/** large counts → 1.5K / 2.3M / 4.1B (1000-based, SI-ish). */
export const si: Formatter = (v) => {
    const units = ['', 'K', 'M', 'B', 'T'];
    let n = v;
    let i = 0;
    while (Math.abs(n) >= 1000 && i < units.length - 1) {
        n /= 1000;
        i++;
    }
    return `${sig(n)}${units[i]}`;
};

/** a percentage suffix. */
export const percent: Formatter = (v) => `${sig(v)}%`;

/** append a literal unit (e.g. `fps`, `ms`, `MB`). */
export function suffix(unit: string): Formatter {
    return (v) => `${Number.isInteger(v) ? v : sig(v)} ${unit}`;
}

/** resolve the `format` / `unit` options into a formatter (explicit `format` wins). */
export function resolveFormat(unit?: string, format?: Formatter): Formatter | undefined {
    if (format) return format;
    if (!unit) return undefined;
    switch (unit) {
        case 'bytes':
            return bytes;
        case 'duration':
            return duration;
        case 'si':
            return si;
        case '%':
        case 'percent':
            return percent;
        default:
            return suffix(unit);
    }
}
