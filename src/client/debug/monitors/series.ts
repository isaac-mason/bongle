import { base, type Control } from '../control';
import { el, on } from '../dom';
import { type Formatter, resolveFormat } from '../format';
import { canvasMonitor } from './canvas';
import { colorResolver, drawBaseline, drawGrid, drawScaleLabels, paletteColor, type Threshold, thresholdColor } from './shared';

export type SeriesOptions = {
    label?: string;
    /** fixed y-range; omit to autoscale to the data in view. */
    min?: number;
    max?: number;
    /** a built-in ('bytes' | 'duration' | 'si' | '%') or a literal unit suffix. */
    unit?: string;
    format?: Formatter;
    /** override the auto-assigned color per series key (semantic name or css color). */
    colors?: Record<string, string>;
    /** per-series color resolver, called when a series first appears (`colors` still
     *  wins). pass `hashColor` to share one color per scope with the flame graph. */
    color?: (key: string) => string;
    /** show the legend row of series + current values (default true). */
    legend?: boolean;
    /** render series as stacked filled areas (sum) instead of overlaid lines. */
    stacked?: boolean;
    /** show a header button that flips between stacked areas and overlaid lines at runtime (default: on when `stacked` is set). */
    stackToggle?: boolean;
    /** draw a horizontal reference line at this value (e.g. a frame budget). */
    baseline?: number;
    /** hover a crosshair to read each series' value at the cursor and highlight the one under it. */
    hover?: boolean;
    /** draw min/mid/max value labels + gridlines so the y-scale is legible (default true). */
    scale?: boolean;
    /** tint a series' legend value when its own value crosses a threshold band. */
    thresholds?: Threshold[];
    /** canvas height in px (default 46). */
    height?: number;
};

type Item = {
    color: string;
    swatchEl: HTMLElement;
    valueEl: HTMLElement;
    itemEl: HTMLElement;
};

/** several named numeric series over time, sharing one y-range, drawn from a
 *  caller-owned history. lines or stacked areas. read-only. */
export function series(opts: SeriesOptions = {}): Control<Record<string, number[]>> {
    return (ctx, prop) => {
        const b = base<Record<string, number[]>>(ctx, prop, opts.label);
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
        const color = colorResolver(b.row);
        const items = new Map<string, Item>();
        const order: string[] = [];

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

        const ensureItem = (key: string): Item => {
            const found = items.get(key);
            if (found) return found;
            const col = opts.colors?.[key] ?? opts.color?.(key) ?? paletteColor(order.length);
            const swatchEl = el('span', 'dc-legend-swatch');
            const valueEl = el('span', 'dc-legend-val');
            const itemEl = el('div', 'dc-legend-item', undefined, [
                swatchEl,
                el('span', 'dc-legend-key', { textContent: key }),
                valueEl,
            ]);
            b.onDispose(on(itemEl, 'click', () => toggleSolo(key)));
            legend.append(itemEl);
            const item: Item = { color: col, swatchEl, valueEl, itemEl };
            items.set(key, item);
            order.push(key);
            return item;
        };

        // the cursor's index while hovering, else the latest sample.
        const indexAt = (hoverX: number | null, w: number, n: number) =>
            hoverX === null ? n - 1 : Math.max(0, Math.min(n - 1, Math.round((hoverX / w) * (n - 1))));

        canvasMonitor(ctx, b, canvas, {
            hover: opts.hover,
            paint: (g, w, h, hover) => {
                const data = prop.get() ?? {};
                for (const key in data) ensureItem(key);
                // a key the source stopped emitting keeps its legend row (colors stay put) but drops out of the drawing.
                const present = order.filter((key) => data[key] !== undefined);
                const shown = present.filter(visible);
                const first = present[0];
                const n = first ? data[first]!.length : 0;
                const idx = indexAt(hover?.[0] ?? null, w, n);

                // hidden series still show their value so you can read what you dropped.
                for (const key of order) {
                    const item = items.get(key)!;
                    item.swatchEl.style.background = color(item.color);
                    const arr = data[key];
                    const val = arr && n ? (arr[idx] ?? 0) : 0;
                    item.valueEl.textContent = fmt(val);
                    const tint = thresholdColor(val, opts.thresholds);
                    item.valueEl.style.color = tint ? color(tint) : '';
                    item.itemEl.classList.toggle('dc-legend-item--hidden', !visible(key));
                }
                if (n < 2) {
                    for (const key of order) items.get(key)!.itemEl.classList.remove('dc-legend-item--active');
                    return;
                }

                const yFor = (v: number, lo: number, hi: number) => h - ((v - lo) / (hi - lo)) * h;
                // which series the cursor is over: the band it sits in (stacked) or the nearest line.
                let hovered: string | undefined;

                if (stacked) {
                    const lo = opts.min ?? 0;
                    let hi = opts.max ?? 0;
                    if (opts.max === undefined) {
                        for (let i = 0; i < n; i++) {
                            let sum = 0;
                            for (const key of shown) sum += data[key]![i] ?? 0;
                            hi = Math.max(hi, sum);
                        }
                    }
                    if (!(hi > lo)) hi = lo + 1;

                    if (hover) {
                        let cum = 0;
                        for (const key of shown) {
                            const val = data[key]![idx] ?? 0;
                            if (hover[1] >= yFor(cum + val, lo, hi) && hover[1] <= yFor(cum, lo, hi)) {
                                hovered = key;
                                break;
                            }
                            cum += val;
                        }
                    }

                    if (opts.scale !== false) drawGrid(g, w, h, color('border'));
                    const cum = new Array<number>(n).fill(0);
                    for (const key of shown) {
                        const arr = data[key]!;
                        g.beginPath();
                        for (let i = 0; i < n; i++) g.lineTo((i / (n - 1)) * w, yFor(cum[i]! + (arr[i] ?? 0), lo, hi));
                        for (let i = n - 1; i >= 0; i--) g.lineTo((i / (n - 1)) * w, yFor(cum[i]!, lo, hi));
                        g.closePath();
                        g.fillStyle = color(items.get(key)!.color);
                        g.globalAlpha = !hovered ? 0.5 : key === hovered ? 0.8 : 0.25;
                        g.fill();
                        g.globalAlpha = 1;
                        for (let i = 0; i < n; i++) cum[i]! += arr[i] ?? 0;
                    }
                    if (opts.baseline !== undefined) drawBaseline(g, w, h, yFor(opts.baseline, lo, hi), color('muted'));
                    if (opts.scale !== false) drawScaleLabels(g, w, h, lo, hi, fmt, color('muted'));
                } else {
                    let lo = opts.min ?? Number.POSITIVE_INFINITY;
                    let hi = opts.max ?? Number.NEGATIVE_INFINITY;
                    if (opts.min === undefined || opts.max === undefined) {
                        for (const key of shown) {
                            for (const v of data[key]!) {
                                if (opts.min === undefined && v < lo) lo = v;
                                if (opts.max === undefined && v > hi) hi = v;
                            }
                        }
                    }
                    if (!Number.isFinite(lo)) lo = 0;
                    if (!Number.isFinite(hi)) hi = lo + 1;
                    if (!(hi > lo)) hi = lo + 1;

                    if (opts.scale !== false) drawGrid(g, w, h, color('border'));
                    if (opts.baseline !== undefined) drawBaseline(g, w, h, yFor(opts.baseline, lo, hi), color('muted'));

                    if (hover) {
                        let best = Number.POSITIVE_INFINITY;
                        for (const key of shown) {
                            const d = Math.abs(yFor(data[key]![idx] ?? 0, lo, hi) - hover[1]);
                            if (d < best) {
                                best = d;
                                hovered = key;
                            }
                        }
                    }

                    for (const key of shown) {
                        const arr = data[key]!;
                        g.strokeStyle = color(items.get(key)!.color);
                        g.lineWidth = key === hovered ? 2 : 1;
                        g.globalAlpha = !hovered || key === hovered ? 1 : 0.4;
                        g.beginPath();
                        for (let i = 0; i < n; i++) {
                            const x = (i / (n - 1)) * w;
                            const y = yFor(arr[i] ?? 0, lo, hi);
                            if (i === 0) g.moveTo(x, y);
                            else g.lineTo(x, y);
                        }
                        g.stroke();
                    }
                    g.globalAlpha = 1;
                    if (opts.scale !== false) drawScaleLabels(g, w, h, lo, hi, fmt, color('muted'));
                }

                for (const key of order) items.get(key)!.itemEl.classList.toggle('dc-legend-item--active', key === hovered);

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
