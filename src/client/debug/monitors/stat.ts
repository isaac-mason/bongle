import { base, type Control } from '../control';
import { el } from '../dom';
import { type Formatter, resolveFormat } from '../format';
import { fitCanvas, watch } from './canvas';
import { sampler, smoother } from './sampler';
import { colorResolver, type Threshold, thresholdColor } from './shared';

export type StatOptions = {
    label?: string;
    /** a built-in ('bytes' | 'duration' | 'si' | '%') or a literal unit suffix. */
    unit?: string;
    format?: Formatter;
    /** minimum ms between refreshes. 0 = every frame. */
    interval?: number;
    /** draw a small sparkline of recent values under the number (default false). */
    spark?: boolean;
    /** show a ▲/▼ change against the oldest sample in the window (default false). */
    delta?: boolean;
    /** a labeled sub-line of readouts over the window, in the given order. e.g. ['min','avg','max']. */
    stats?: Array<'min' | 'avg' | 'max'>;
    /** samples kept for the sparkline / delta / stats. */
    history?: number;
    /** exponential smoothing, 0 (off) .. ~0.9 (heavy). */
    smooth?: number;
    /** color the number once a value threshold is crossed. */
    thresholds?: Threshold[];
};

/** a headline number with optional sparkline, delta, and threshold color. read-only. */
export function stat(opts: StatOptions = {}): Control<number> {
    return (ctx, prop) => {
        const b = base<number>(ctx, prop, opts.label);
        b.row.classList.add('dc-stat-row');
        b.labelEl.remove();
        b.controlEl.remove();

        const labelEl = el('div', 'dc-stat-label', { textContent: opts.label ?? prop.name ?? '' });
        const valueEl = el('span', 'dc-stat-value');
        const deltaEl = el('span', 'dc-stat-delta');
        const main = el('div', 'dc-stat-main', undefined, opts.delta ? [valueEl, deltaEl] : [valueEl]);
        b.row.append(labelEl, main);

        // optional labeled sub-line: each `kind` renders `kind <b>value</b>`, updated in place
        const statEls = (opts.stats ?? []).map((kind) => {
            const val = el('b');
            return { kind, val, span: el('span', undefined, undefined, [document.createTextNode(`${kind} `), val]) };
        });
        if (statEls.length)
            b.row.append(
                el(
                    'div',
                    'dc-graph-stats',
                    undefined,
                    statEls.map((s) => s.span),
                ),
            );

        let canvas: HTMLCanvasElement | undefined;
        if (opts.spark) {
            canvas = el('canvas', 'dc-stat-spark');
            b.row.append(canvas);
        }

        const fmt = resolveFormat(opts.unit, opts.format) ?? ((v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
        const size = opts.history ?? 60;
        const s = sampler(size);
        const smooth = smoother(opts.smooth);
        const color = colorResolver(b.row);
        b.setReset(() => s.clear());

        watch(ctx, b, b.row, {
            interval: opts.interval,
            update: () => {
                const v = smooth(prop.get());
                s.push(v);
                valueEl.textContent = fmt(v);

                const col = thresholdColor(v, opts.thresholds);
                valueEl.style.color = col ? color(col) : '';

                // `kind` is exactly a Sampler method name ('min' | 'avg' | 'max')
                for (const st of statEls) st.val.textContent = fmt(s[st.kind]());

                if (opts.delta) {
                    const past = s.at(0);
                    const d = v - past;
                    const eps = Math.abs(v) * 1e-6;
                    deltaEl.textContent = d > eps ? `▲ ${fmt(Math.abs(d))}` : d < -eps ? `▼ ${fmt(Math.abs(d))}` : '–';
                    deltaEl.className = `dc-stat-delta${d > eps ? ' dc-stat-delta--up' : d < -eps ? ' dc-stat-delta--down' : ''}`;
                }

                if (canvas && s.count > 1) {
                    const { g, w, h } = fitCanvas(canvas);
                    const lo = s.min();
                    const hi = s.max();
                    const span = hi - lo || 1;
                    g.strokeStyle = color('accent');
                    g.lineWidth = 1;
                    g.beginPath();
                    for (let i = 0; i < s.count; i++) {
                        const x = (i / (s.count - 1)) * w;
                        const y = h - ((s.at(i) - lo) / span) * (h - 2) - 1;
                        if (i === 0) g.moveTo(x, y);
                        else g.lineTo(x, y);
                    }
                    g.stroke();
                }
            },
        });
        return b.handle;
    };
}
