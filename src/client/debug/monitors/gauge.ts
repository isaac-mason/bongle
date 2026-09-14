import { base, type Control } from '../control';
import { el } from '../dom';
import { type Formatter, resolveFormat } from '../format';
import { canvasMonitor } from './canvas';
import { sampler, smoother } from './sampler';
import { colorResolver, type Threshold, thresholdColor } from './shared';

export type GaugeOptions = {
    label?: string;
    /** arc range. default 0..100. */
    min?: number;
    max?: number;
    /** minimum ms between refreshes. 0 = every frame. */
    interval?: number;
    /** a built-in ('bytes' | 'duration' | 'si' | '%') or a literal unit suffix. */
    unit?: string;
    format?: Formatter;
    /** value-arc color when no threshold is active (semantic name or css). default accent. */
    color?: string;
    /** exponential smoothing, 0 (off) .. ~0.9 (heavy). */
    smooth?: number;
    /** color the value arc once a threshold is crossed (else `color`). */
    thresholds?: Threshold[];
    /** draw the threshold bands as faint colored arc segments under the value. */
    zones?: boolean;
    /** a labeled sub-line of readouts over a recent window, e.g. ['avg','max']. */
    stats?: Array<'min' | 'avg' | 'max'>;
    /** samples kept for `stats`. */
    history?: number;
    /** canvas height in px (default 72). */
    height?: number;
};

const START = Math.PI * 0.75; // 270° sweep, opening at the bottom
const SWEEP = Math.PI * 1.5;
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

/** a scalar on a min..max arc with threshold coloring/zones and a center readout. read-only. */
export function gauge(opts: GaugeOptions = {}): Control<number> {
    return (ctx, prop) => {
        const b = base<number>(ctx, prop, opts.label);
        b.row.classList.add('dc-graph-row');
        b.labelEl.remove();
        b.controlEl.remove();
        const head = el('div', 'dc-graph-head', undefined, [
            el('span', undefined, { textContent: opts.label ?? prop.name ?? '' }),
        ]);
        const canvas = el('canvas', 'dc-gauge');
        if (opts.height) canvas.style.height = `${opts.height}px`;
        const loEl = el('span');
        const hiEl = el('span');
        const scale = el('div', 'dc-graph-stats', undefined, [loEl, hiEl]);
        b.row.append(head, canvas, scale);

        // optional windowed readouts (avg / peak) under the arc
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
                    statEls.map((st) => st.span),
                ),
            );

        const fmt = resolveFormat(opts.unit, opts.format) ?? ((v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
        const min = opts.min ?? 0;
        const max = opts.max ?? 100;
        const color = colorResolver(b.row);
        const baseColor = opts.color ?? 'accent';
        const smooth = smoother(opts.smooth);
        const s = statEls.length ? sampler(opts.history ?? 120) : undefined;
        s && b.setReset(() => s.clear());
        const font = `600 14px ${getComputedStyle(b.row).getPropertyValue('--dc-font').trim() || 'ui-monospace, monospace'}`;
        const angleOf = (v: number) => START + SWEEP * clamp01((v - min) / (max - min || 1));

        canvasMonitor(ctx, b, canvas, {
            interval: opts.interval,
            tick: s ? () => s.push(smooth(prop.get())) : undefined,
            paint: (g, w, h) => {
                const v = s ? s.last() : smooth(prop.get());
                const cx = w / 2;
                const cy = h * 0.6;
                const r = Math.min(w / 2, cy) - 6;
                if (r <= 0) return; // canvas not laid out yet (arc() throws on a negative radius)

                g.lineWidth = 6;
                g.lineCap = 'round';
                g.strokeStyle = color('border');
                g.beginPath();
                g.arc(cx, cy, r, START, START + SWEEP);
                g.stroke();

                if (opts.zones && opts.thresholds?.length) {
                    const sorted = [...opts.thresholds].sort((a, c) => a.at - c.at);
                    for (let i = 0; i < sorted.length; i++) {
                        const from = Math.max(min, sorted[i].at);
                        const to = i + 1 < sorted.length ? sorted[i + 1].at : max;
                        if (to <= from) continue;
                        g.strokeStyle = color(sorted[i].color);
                        g.globalAlpha = 0.35;
                        g.beginPath();
                        g.arc(cx, cy, r, angleOf(from), angleOf(to));
                        g.stroke();
                        g.globalAlpha = 1;
                    }
                }

                g.strokeStyle = color(thresholdColor(v, opts.thresholds) ?? baseColor);
                g.beginPath();
                g.arc(cx, cy, r, START, angleOf(v));
                g.stroke();

                g.fillStyle = color('fg');
                g.textAlign = 'center';
                g.textBaseline = 'middle';
                g.font = font;
                g.fillText(fmt(v), cx, cy);

                loEl.textContent = fmt(min);
                hiEl.textContent = fmt(max);
                if (s) for (const st of statEls) st.val.textContent = fmt(s[st.kind]());
            },
        });
        return b.handle;
    };
}
