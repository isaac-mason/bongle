import { base, type Control } from '../control';
import { el } from '../dom';
import { canvasMonitor } from './canvas';
import { colorResolver, paletteColor } from './shared';

export type StateValue = string | number | boolean;

export type StatesOptions = {
    label?: string;
    /** samples kept in the strip. */
    history?: number;
    /** minimum ms between samples. 0 = every frame. */
    interval?: number;
    /** map a state to a semantic name or css color. unmapped states cycle the palette. */
    colors?: Record<string, string>;
    /** show a legend of each seen state with its % dwell time over the window. */
    legend?: boolean;
    /** strip height in px (default 16). */
    height?: number;
};

/** an enum/bool sampled over time, drawn as a colored timeline strip. read-only. */
export function states(opts: StatesOptions = {}): Control<StateValue> {
    return (ctx, prop) => {
        const b = base<StateValue>(ctx, prop, opts.label);
        b.row.classList.add('dc-graph-row');
        b.labelEl.remove();
        b.controlEl.remove();
        const nowEl = el('span', 'dc-graph-now');
        const head = el('div', 'dc-graph-head', undefined, [
            el('span', undefined, { textContent: opts.label ?? prop.name ?? '' }),
            nowEl,
        ]);
        const canvas = el('canvas', 'dc-states');
        if (opts.height) canvas.style.height = `${opts.height}px`;
        const legend = el('div', 'dc-legend');
        b.row.append(head, canvas);
        if (opts.legend) b.row.append(legend);

        const size = opts.history ?? 120;
        const buf = new Array<string>(size);
        let hd = 0;
        let count = 0;
        const at = (i: number) => buf[(hd - count + i + size * 2) % size];
        b.setReset(() => {
            hd = 0;
            count = 0;
        });

        const color = colorResolver(b.row);
        const named = new Map<string, string>();
        let nextColor = 0;
        const nameFor = (state: string) => {
            let c = named.get(state);
            if (!c) {
                c = opts.colors?.[state] ?? paletteColor(nextColor++);
                named.set(state, c);
            }
            return c;
        };

        // one legend row per seen state, created lazily; its % dwell updates each paint
        const legendItems = new Map<string, { swatch: HTMLElement; pct: HTMLElement }>();
        const ensureLegend = (state: string) => {
            let item = legendItems.get(state);
            if (item || !opts.legend) return item;
            const swatch = el('span', 'dc-legend-swatch');
            const pct = el('span', 'dc-legend-val');
            legend.append(
                el('div', 'dc-legend-item', undefined, [swatch, el('span', 'dc-legend-key', { textContent: state }), pct]),
            );
            item = { swatch, pct };
            legendItems.set(state, item);
            return item;
        };

        canvasMonitor(ctx, b, canvas, {
            interval: opts.interval,
            tick: () => {
                buf[hd] = String(prop.get());
                hd = (hd + 1) % size;
                if (count < size) count++;
            },
            paint: (g, w, h) => {
                if (count === 0) return;
                const cellW = w / count;
                const tally = opts.legend ? new Map<string, number>() : undefined;
                // coalesce runs of the same state into one fillRect instead of one per cell
                let runStart = 0;
                let runColor = color(nameFor(at(0)));
                for (let i = 1; i <= count; i++) {
                    if (tally && i <= count) {
                        const st = at(i - 1);
                        tally.set(st, (tally.get(st) ?? 0) + 1);
                    }
                    const c = i < count ? color(nameFor(at(i))) : '';
                    if (c !== runColor || i === count) {
                        g.fillStyle = runColor;
                        g.fillRect(runStart * cellW, 0, (i - runStart) * cellW + 0.5, h);
                        runStart = i;
                        runColor = c;
                    }
                }
                const current = at(count - 1);
                nowEl.textContent = current;
                nowEl.style.color = color(nameFor(current));

                if (tally) {
                    for (const [state, num] of tally) {
                        const item = ensureLegend(state);
                        if (!item) continue;
                        item.swatch.style.background = color(nameFor(state));
                        item.pct.textContent = `${Math.round((num / count) * 100)}%`;
                    }
                }
            },
        });
        return b.handle;
    };
}
