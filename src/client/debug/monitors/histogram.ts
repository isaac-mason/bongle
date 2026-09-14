import { base, type Control } from '../control';
import { el } from '../dom';
import { type Formatter, resolveFormat } from '../format';
import { canvasMonitor } from './canvas';
import { sampler } from './sampler';
import { colorResolver } from './shared';

export type HistogramOptions = {
    label?: string;
    /** fixed value range. omit to autoscale (expands to fit, never shrinks, so bars stay put). */
    range?: [number, number];
    /** number of buckets. default 24. */
    buckets?: number;
    /** recent samples counted into the distribution. */
    history?: number;
    /** minimum ms between samples. 0 = every frame. */
    interval?: number;
    /** a built-in ('bytes' | 'duration' | 'si' | '%') or a literal unit suffix. */
    unit?: string;
    format?: Formatter;
    /** bar color (semantic name or css color). default accent. */
    color?: string;
    /** draw marker lines at these percentiles of the window, e.g. [50, 95]. */
    percentiles?: number[];
    /** hover a crosshair to read the bucket under the cursor. */
    hover?: boolean;
    /** canvas height in px (default 46). */
    height?: number;
};

/** the distribution of a scalar over a recent window, as bucketed bars. read-only. */
export function histogram(opts: HistogramOptions = {}): Control<number> {
    return (ctx, prop) => {
        const b = base<number>(ctx, prop, opts.label);
        b.row.classList.add('dc-graph-row');
        b.labelEl.remove();
        b.controlEl.remove();
        const nowEl = el('span', 'dc-graph-now');
        const head = el('div', 'dc-graph-head', undefined, [
            el('span', undefined, { textContent: opts.label ?? prop.name ?? '' }),
            nowEl,
        ]);
        const canvas = el('canvas', 'dc-graph');
        if (opts.height) canvas.style.height = `${opts.height}px`;
        const loEl = el('b');
        const midEl = el('span');
        const hiEl = el('b');
        const stats = el('div', 'dc-graph-stats', undefined, [loEl, midEl, hiEl]);
        b.row.append(head, canvas, stats);

        const fmt = resolveFormat(opts.unit, opts.format) ?? ((v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
        const s = sampler(opts.history ?? 240);
        const color = colorResolver(b.row);
        const baseColor = opts.color ?? 'accent';
        const n = opts.buckets ?? 24;
        const font = `9px ${getComputedStyle(b.row).getPropertyValue('--dc-font').trim() || 'ui-monospace, monospace'}`;
        let lo = opts.range ? opts.range[0] : Infinity;
        let hi = opts.range ? opts.range[1] : -Infinity;
        b.setReset(() => {
            s.clear();
            if (!opts.range) {
                lo = Infinity;
                hi = -Infinity;
            }
        });

        // the p-th percentile of the windowed samples (sorted copy; cheap at these sizes)
        const percentile = (p: number, sorted: number[]) =>
            sorted[Math.max(0, Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))))];

        canvasMonitor(ctx, b, canvas, {
            interval: opts.interval,
            hover: opts.hover,
            tick: () => {
                const v = prop.get();
                s.push(v);
                if (!opts.range) {
                    lo = Math.min(lo, v);
                    hi = Math.max(hi, v);
                }
            },
            paint: (g, w, h, hover) => {
                nowEl.textContent = fmt(s.last());
                if (s.count < 1 || !Number.isFinite(lo) || !Number.isFinite(hi)) return;
                const span = hi - lo || 1;
                const counts = new Array<number>(n).fill(0);
                for (let i = 0; i < s.count; i++) {
                    let bi = Math.floor(((s.at(i) - lo) / span) * n);
                    if (bi < 0) bi = 0;
                    if (bi >= n) bi = n - 1;
                    counts[bi]++;
                }
                let maxC = 1;
                for (const c of counts) maxC = Math.max(maxC, c);
                const bw = w / n;
                const hoverBucket = hover === null ? -1 : Math.max(0, Math.min(n - 1, Math.floor((hover[0] / w) * n)));

                const barColor = color(baseColor);
                for (let i = 0; i < n; i++) {
                    const bh = (counts[i] / maxC) * h;
                    g.fillStyle = barColor;
                    g.globalAlpha = i === hoverBucket ? 1 : 0.85;
                    g.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh);
                }
                g.globalAlpha = 1;

                if (opts.percentiles?.length) {
                    const sorted = Array.from({ length: s.count }, (_, i) => s.at(i)).sort((a, c) => a - c);
                    g.font = font;
                    g.textBaseline = 'top';
                    for (const p of opts.percentiles) {
                        const pv = percentile(p, sorted);
                        const x = ((pv - lo) / span) * w;
                        g.strokeStyle = color('fg');
                        g.globalAlpha = 0.7;
                        g.setLineDash([2, 2]);
                        g.beginPath();
                        g.moveTo(x, 0);
                        g.lineTo(x, h);
                        g.stroke();
                        g.setLineDash([]);
                        g.fillStyle = color('fg');
                        g.textAlign = x > w * 0.7 ? 'right' : 'left';
                        g.fillText(`p${p}`, x + (x > w * 0.7 ? -2 : 2), 1);
                        g.globalAlpha = 1;
                    }
                }

                if (hoverBucket >= 0) {
                    const bl = lo + (hoverBucket / n) * span;
                    const bh = lo + ((hoverBucket + 1) / n) * span;
                    nowEl.textContent = `${fmt(bl)}–${fmt(bh)} · ${counts[hoverBucket]}`;
                }

                loEl.textContent = fmt(lo);
                midEl.textContent = `${s.count} samples`;
                hiEl.textContent = fmt(hi);
            },
        });
        return b.handle;
    };
}
