import { base, type Control } from '../control';
import { el, on } from '../dom';
import { type Formatter, resolveFormat } from '../format';
import { canvasMonitor } from './canvas';
import { autorange, type Sampler, sampler, smoother } from './sampler';
import { colorResolver, drawBaseline, drawGrid, drawScaleLabels, paletteColor, type Threshold, thresholdColor } from './shared';

export type LinesOptions = {
    label?: string;
    /** fixed y-range shared by all series. omit to autoscale to the samples in view. */
    min?: number;
    max?: number;
    /** samples kept / plotted per series. */
    history?: number;
    /** minimum ms between samples. 0 = every frame. */
    interval?: number;
    /** a built-in ('bytes' | 'duration' | 'si' | '%') or a literal unit suffix. */
    unit?: string;
    format?: Formatter;
    /** override the auto-assigned color per series key (semantic name or css color). */
    colors?: Record<string, string>;
    /** show the legend row of series + current values (default true). */
    legend?: boolean;
    /** exponential smoothing applied to every series, 0 (off) .. ~0.9 (heavy). */
    smooth?: number;
    /** draw a horizontal reference line at this value (e.g. a frame budget). */
    baseline?: number;
    /** render series as stacked filled areas (sum) instead of overlaid lines. */
    stacked?: boolean;
    /** show a header button that flips between stacked areas and overlaid lines at runtime (default: on when `stacked` is set). */
    stackToggle?: boolean;
    /** draw min/mid/max value labels + gridlines so the y-scale is legible (default true). */
    scale?: boolean;
    /** tint a series' legend value when its own value crosses a threshold band. */
    thresholds?: Threshold[];
    /** hover a crosshair to read each series' value at the cursor and highlight the one under it. */
    hover?: boolean;
    /** canvas height in px (default 46). */
    height?: number;
};

type Series = {
    sampler: Sampler;
    smooth: (v: number) => number;
    color: string;
    swatchEl: HTMLElement;
    valueEl: HTMLElement;
    itemEl: HTMLElement;
};

/** several named numeric series over time, sharing one y-range. lines or stacked areas. read-only. */
export function lines(opts: LinesOptions = {}): Control<Record<string, number>> {
    return (ctx, prop) => {
        const b = base<Record<string, number>>(ctx, prop, opts.label);
        b.row.classList.add('dc-graph-row');
        b.labelEl.remove();
        b.controlEl.remove();
        const head = el('div', 'dc-graph-head', undefined, [
            el('span', undefined, { textContent: opts.label ?? prop.name ?? '' }),
        ]);
        const canvas = el('canvas', 'dc-graph');
        if (opts.height) canvas.style.height = `${opts.height}px`;
        const legend = el('div', 'dc-legend');
        b.row.append(head, canvas);
        if (opts.legend !== false) b.row.append(legend);

        const fmt = resolveFormat(opts.unit, opts.format) ?? ((v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
        const size = opts.history ?? 120;
        const color = colorResolver(b.row);
        const series = new Map<string, Series>();
        const order: string[] = [];
        b.setReset(() => {
            for (const s of series.values()) s.sampler.clear();
        });

        let stacked = opts.stacked ?? false;
        // empty solo set means "show all"; clicking keys grows it, and once every series is back in it collapses to "show all".
        const solo = new Set<string>();
        const visible = (key: string) => solo.size === 0 || solo.has(key);
        const toggleSolo = (key: string) => {
            if (solo.has(key)) solo.delete(key);
            else {
                solo.add(key);
                if (solo.size === order.length) solo.clear();
            }
        };

        if (opts.stackToggle ?? opts.stacked) {
            const toggle = el('button', 'dc-graph-toggle', { type: 'button', textContent: stacked ? 'stacked' : 'lines' });
            b.onDispose(
                on(toggle, 'click', () => {
                    stacked = !stacked;
                    toggle.textContent = stacked ? 'stacked' : 'lines';
                }),
            );
            head.append(toggle);
        }

        const ensureSeries = (key: string): Series => {
            const found = series.get(key);
            if (found) return found;
            const col = opts.colors?.[key] ?? paletteColor(order.length);
            const swatchEl = el('span', 'dc-legend-swatch');
            const valueEl = el('span', 'dc-legend-val');
            const itemEl = el('div', 'dc-legend-item', undefined, [
                swatchEl,
                el('span', 'dc-legend-key', { textContent: key }),
                valueEl,
            ]);
            b.onDispose(on(itemEl, 'click', () => toggleSolo(key)));
            legend.append(itemEl);
            const s: Series = { sampler: sampler(size), smooth: smoother(opts.smooth), color: col, swatchEl, valueEl, itemEl };
            series.set(key, s);
            order.push(key);
            return s;
        };

        // the cursor's index while hovering, else the latest sample.
        const indexAt = (hoverX: number | null, w: number, n: number) =>
            hoverX === null ? n - 1 : Math.max(0, Math.min(n - 1, Math.round((hoverX / w) * (n - 1))));

        canvasMonitor(ctx, b, canvas, {
            interval: opts.interval,
            hover: opts.hover,
            tick: () => {
                const rec = prop.get() ?? {};
                for (const key in rec) ensureSeries(key);
                // advance every known series each tick so their sample counts stay aligned.
                for (const key of order) {
                    const s = series.get(key)!;
                    s.sampler.push(s.smooth(rec[key] ?? 0));
                }
            },
            paint: (g, w, h, hover) => {
                const n = order.length ? series.get(order[0])!.sampler.count : 0;
                const idx = indexAt(hover?.[0] ?? null, w, n);
                const shown = order.filter(visible);

                // hidden series still show their value so you can read what you dropped.
                for (const key of order) {
                    const s = series.get(key)!;
                    s.swatchEl.style.background = color(s.color);
                    const val = n ? s.sampler.at(idx) : 0;
                    s.valueEl.textContent = fmt(val);
                    const tint = thresholdColor(val, opts.thresholds);
                    s.valueEl.style.color = tint ? color(tint) : '';
                    s.itemEl.classList.toggle('dc-legend-item--hidden', !visible(key));
                }
                if (n < 2) {
                    for (const key of order) series.get(key)!.itemEl.classList.remove('dc-legend-item--active');
                    return;
                }

                const yFor = (v: number, lo: number, hi: number) => h - ((v - lo) / (hi - lo)) * h;
                // which series the cursor is over: the band it sits in (stacked) or the nearest line.
                let hovered: string | undefined;

                if (stacked) {
                    let hi = opts.max ?? 0;
                    if (opts.max === undefined) {
                        for (let i = 0; i < n; i++) {
                            let sum = 0;
                            for (const key of shown) sum += series.get(key)!.sampler.at(i);
                            hi = Math.max(hi, sum);
                        }
                    }
                    const lo = opts.min ?? 0;
                    if (!(hi > lo)) hi = lo + 1;

                    if (hover) {
                        let c = 0;
                        for (const key of shown) {
                            const val = series.get(key)!.sampler.at(idx);
                            if (hover[1] >= yFor(c + val, lo, hi) && hover[1] <= yFor(c, lo, hi)) {
                                hovered = key;
                                break;
                            }
                            c += val;
                        }
                    }

                    if (opts.scale !== false) drawGrid(g, w, h, color('border'));
                    const cum = new Array<number>(n).fill(0);
                    for (const key of shown) {
                        const s = series.get(key)!.sampler;
                        g.beginPath();
                        for (let i = 0; i < n; i++) g.lineTo((i / (n - 1)) * w, yFor(cum[i] + s.at(i), lo, hi));
                        for (let i = n - 1; i >= 0; i--) g.lineTo((i / (n - 1)) * w, yFor(cum[i], lo, hi));
                        g.closePath();
                        g.fillStyle = color(series.get(key)!.color);
                        g.globalAlpha = !hovered ? 0.5 : key === hovered ? 0.8 : 0.25;
                        g.fill();
                        g.globalAlpha = 1;
                        for (let i = 0; i < n; i++) cum[i] += s.at(i);
                    }
                    if (opts.scale !== false) drawScaleLabels(g, w, h, lo, hi, fmt, color('muted'));
                } else {
                    const [lo, hi] = autorange(
                        shown.map((k) => series.get(k)!.sampler),
                        opts.min,
                        opts.max,
                    );
                    if (opts.scale !== false) drawGrid(g, w, h, color('border'));
                    if (opts.baseline !== undefined) drawBaseline(g, w, h, yFor(opts.baseline, lo, hi), color('muted'));

                    if (hover) {
                        let best = Infinity;
                        for (const key of shown) {
                            const d = Math.abs(yFor(series.get(key)!.sampler.at(idx), lo, hi) - hover[1]);
                            if (d < best) {
                                best = d;
                                hovered = key;
                            }
                        }
                    }

                    for (const key of shown) {
                        const s = series.get(key)!.sampler;
                        g.strokeStyle = color(series.get(key)!.color);
                        g.lineWidth = key === hovered ? 2 : 1;
                        g.globalAlpha = !hovered || key === hovered ? 1 : 0.4;
                        g.beginPath();
                        for (let i = 0; i < n; i++) {
                            const x = (i / (n - 1)) * w;
                            const y = yFor(s.at(i), lo, hi);
                            if (i === 0) g.moveTo(x, y);
                            else g.lineTo(x, y);
                        }
                        g.stroke();
                    }
                    g.globalAlpha = 1;
                    if (opts.scale !== false) drawScaleLabels(g, w, h, lo, hi, fmt, color('muted'));
                }

                for (const key of order) series.get(key)!.itemEl.classList.toggle('dc-legend-item--active', key === hovered);

                if (hover) {
                    const x = (idx / (n - 1)) * w;
                    g.strokeStyle = color('muted');
                    g.globalAlpha = 0.6;
                    g.beginPath();
                    g.moveTo(x, 0);
                    g.lineTo(x, h);
                    g.stroke();
                    g.globalAlpha = 1;
                }
            },
        });
        return b.handle;
    };
}
