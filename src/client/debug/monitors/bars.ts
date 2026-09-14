import { base, type Control } from '../control';
import { el } from '../dom';
import { type Formatter, resolveFormat } from '../format';
import { watch } from './canvas';
import { colorResolver, type Threshold, thresholdColor } from './shared';

export type BarsOptions = {
    label?: string;
    /** fixed max for the bar scale. omit to autoscale to the largest current value. */
    max?: number;
    /** minimum ms between refreshes. 0 = every frame. */
    interval?: number;
    /** a built-in ('bytes' | 'duration' | 'si' | '%') or a literal unit suffix. */
    unit?: string;
    format?: Formatter;
    /** reorder bars by value, largest first, each frame (default false = insertion order). */
    sort?: boolean;
    /** show only the largest N categories; the rest fold into an "other" bar. */
    limit?: number;
    /** per-key bar color (semantic name or css color). default accent. */
    colors?: Record<string, string>;
    /** color a bar once its value crosses a threshold. */
    thresholds?: Threshold[];
};

type Bar = { row: HTMLElement; fill: HTMLElement; valueEl: HTMLElement; color: string };

/** a live bar per category, no history. autoscaled (or fixed `max`). read-only. */
export function bars(opts: BarsOptions = {}): Control<Record<string, number>> {
    return (ctx, prop) => {
        const b = base<Record<string, number>>(ctx, prop, opts.label);
        b.row.classList.add('dc-row--stacked');
        if (opts.label ?? prop.name) b.labelEl.textContent = opts.label ?? prop.name ?? '';
        else b.labelEl.remove();

        const box = el('div', 'dc-bars');
        b.controlEl.append(box);

        const fmt = resolveFormat(opts.unit, opts.format) ?? ((v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)));
        const color = colorResolver(b.row);
        const bars = new Map<string, Bar>();
        const order: string[] = [];
        const limit = opts.limit;

        const makeBar = (label: string, colorName: string): Bar => {
            const fill = el('span', 'dc-bar-fill');
            const track = el('span', 'dc-bar-track', undefined, [fill]);
            const valueEl = el('span', 'dc-bar-val');
            const row = el('div', 'dc-bar', undefined, [
                el('span', 'dc-bar-label', { textContent: label, title: label }),
                track,
                valueEl,
            ]);
            box.append(row);
            return { row, fill, valueEl, color: colorName };
        };
        const ensureBar = (key: string): Bar => {
            const found = bars.get(key);
            if (found) return found;
            const bar = makeBar(key, opts.colors?.[key] ?? 'accent');
            bars.set(key, bar);
            order.push(key);
            return bar;
        };

        // the rolled-up "other" bar for categories beyond `limit`
        let other: Bar | undefined;
        const paintBar = (bar: Bar, v: number, max: number, ord: number) => {
            bar.row.style.display = '';
            bar.row.style.order = String(ord);
            bar.fill.style.width = `${Math.max(0, Math.min(1, v / max)) * 100}%`;
            bar.fill.style.background = color(thresholdColor(v, opts.thresholds) ?? bar.color);
            bar.valueEl.textContent = fmt(v);
        };

        watch(ctx, b, b.row, {
            interval: opts.interval,
            update: () => {
                const rec = prop.get() ?? {};
                for (const key in rec) ensureBar(key);

                // choose which keys are visible (top-N by value when `limit` is set)
                let visible = order;
                let otherSum = 0;
                if (limit && order.length > limit) {
                    const ranked = [...order].sort((a, c) => (rec[c] ?? 0) - (rec[a] ?? 0));
                    visible = ranked.slice(0, limit);
                    for (const k of ranked.slice(limit)) otherSum += rec[k] ?? 0;
                }
                const shown = new Set(visible);

                let max = opts.max ?? 1;
                if (opts.max === undefined) {
                    for (const key of visible) max = Math.max(max, rec[key] ?? 0);
                    max = Math.max(max, otherSum);
                }

                const rank =
                    opts.sort || limit !== undefined ? [...visible].sort((a, c) => (rec[c] ?? 0) - (rec[a] ?? 0)) : visible;
                const ordOf = new Map(rank.map((k, i) => [k, i]));
                for (const key of order) {
                    const bar = bars.get(key)!;
                    if (limit && !shown.has(key)) {
                        bar.row.style.display = 'none';
                        continue;
                    }
                    paintBar(bar, rec[key] ?? 0, max, ordOf.get(key) ?? 0);
                }

                if (otherSum > 0) {
                    if (!other) other = makeBar('other', 'muted');
                    paintBar(other, otherSum, max, visible.length);
                } else if (other) {
                    other.row.style.display = 'none';
                }
            },
        });
        return b.handle;
    };
}
