import { base, type Control } from '../control';
import { el } from '../dom';
import { type Formatter, resolveFormat } from '../format';
import { canvasMonitor } from './canvas';
import { autorange, sampler, smoother } from './sampler';
import { colorResolver, type Threshold, thresholdColor } from './shared';

export type GraphOptions = {
    label?: string;
    /** fixed y-range. omit to autoscale to the samples in view. */
    min?: number;
    max?: number;
    /** samples kept / plotted. */
    history?: number;
    /** minimum ms between samples. 0 = every frame. */
    interval?: number;
    /** a built-in ('bytes' | 'duration' | 'si' | '%') or a literal unit suffix, applied to the value + min/avg/max. */
    unit?: string;
    format?: Formatter;
    /** line color (semantic name or css color). default accent. */
    color?: string;
    /** exponential smoothing, 0 (off) .. ~0.9 (heavy). calms jitter without dropping data. */
    smooth?: number;
    /** draw a horizontal reference line at this value (e.g. a frame budget). */
    baseline?: number;
    /** color the line by the active threshold band (overrides `color`). */
    thresholds?: Threshold[];
    /** overlay a crosshair reading the value under the cursor (data keeps flowing). */
    hover?: boolean;
    /** canvas height in px (default 46). */
    height?: number;
};

/** a live line graph of a numeric prop, sampled into a ring buffer. read-only. */
export function graph(opts: GraphOptions = {}): Control<number> {
    return (ctx, prop) => {
        const b = base<number>(ctx, prop, opts.label);
        // rebuild the row as a vertical stack: [label · current value] over the canvas.
        b.row.classList.add('dc-graph-row');
        b.labelEl.remove();
        b.controlEl.remove();
        const valueEl = el('span', 'dc-graph-now');
        const head = el('div', 'dc-graph-head', undefined, [
            el('span', undefined, { textContent: opts.label ?? prop.name ?? '' }),
            valueEl,
        ]);
        const canvas = el('canvas', 'dc-graph');
        if (opts.height) canvas.style.height = `${opts.height}px`;
        // build each stat as `label <b>value</b>` once; paint only updates the <b> text (no innerHTML reparse)
        const mkStat = (label: string) => {
            const val = el('b');
            return { span: el('span', undefined, undefined, [document.createTextNode(`${label} `), val]), val };
        };
        const mn = mkStat('min');
        const av = mkStat('avg');
        const mx = mkStat('max');
        const stats = el('div', 'dc-graph-stats', undefined, [mn.span, av.span, mx.span]);
        b.row.append(head, canvas, stats);

        const fmt = resolveFormat(opts.unit, opts.format) ?? ((v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
        const s = sampler(opts.history ?? 120);
        const smooth = smoother(opts.smooth);
        const color = colorResolver(b.row);
        const baseColor = opts.color ?? 'accent';
        b.setReset(() => s.clear());

        canvasMonitor(ctx, b, canvas, {
            interval: opts.interval,
            hover: opts.hover,
            tick: () => s.push(smooth(prop.get())),
            paint: (g, w, h, hover) => {
                // the head + stats readout reflects the sampler, and pauses off-screen with paint
                valueEl.textContent = fmt(s.last());
                mn.val.textContent = fmt(s.min());
                av.val.textContent = fmt(s.avg());
                mx.val.textContent = fmt(s.max());
                if (s.count < 2) return;
                const [lo, hi] = autorange([s], opts.min, opts.max);
                const y = (v: number) => h - ((v - lo) / (hi - lo)) * h;

                if (opts.baseline !== undefined) {
                    const by = y(opts.baseline);
                    g.strokeStyle = color('muted');
                    g.globalAlpha = 0.5;
                    g.setLineDash([3, 3]);
                    g.lineWidth = 1;
                    g.beginPath();
                    g.moveTo(0, by);
                    g.lineTo(w, by);
                    g.stroke();
                    g.setLineDash([]);
                    g.globalAlpha = 1;
                }

                const stroke = color(thresholdColor(s.last(), opts.thresholds) ?? baseColor);
                g.strokeStyle = stroke;
                g.lineWidth = 1;
                g.beginPath();
                for (let i = 0; i < s.count; i++) {
                    const x = (i / (s.count - 1)) * w;
                    const yy = y(s.at(i));
                    if (i === 0) g.moveTo(x, yy);
                    else g.lineTo(x, yy);
                }
                g.stroke();

                if (hover) {
                    const idx = Math.max(0, Math.min(s.count - 1, Math.round((hover[0] / w) * (s.count - 1))));
                    const x = (idx / (s.count - 1)) * w;
                    const v = s.at(idx);
                    g.strokeStyle = color('muted');
                    g.globalAlpha = 0.6;
                    g.beginPath();
                    g.moveTo(x, 0);
                    g.lineTo(x, h);
                    g.stroke();
                    g.globalAlpha = 1;
                    g.fillStyle = stroke;
                    g.beginPath();
                    g.arc(x, y(v), 2.5, 0, Math.PI * 2);
                    g.fill();
                    valueEl.textContent = fmt(v);
                }
            },
        });
        return b.handle;
    };
}
