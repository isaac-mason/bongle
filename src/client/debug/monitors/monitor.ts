import { base, type Control } from '../control';
import { el, on } from '../dom';
import { type Formatter, resolveFormat } from '../format';

export type MonitorOptions<T> = {
    label?: string;
    hint?: string;
    /** minimum ms between refreshes (throttle). 0 = every frame. */
    interval?: number;
    /** a built-in ('bytes' | 'duration' | 'si' | '%') or a literal unit suffix ('fps', 'ms', …). */
    unit?: string;
    format?: (value: T) => string;
    /** make the readout click-to-copy: clicking writes the current formatted text
     *  to the clipboard and flashes success. handy for coords, ids, keys. */
    copy?: boolean;
};

function defaultFormat(value: unknown): string {
    if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
    return String(value);
}

/** a read-only live readout of a prop. bind a getter-only prop. */
export function monitor<T = unknown>(opts: MonitorOptions<T> = {}): Control<T> {
    return (ctx, prop) => {
        const b = base<T>(ctx, prop, opts.label);
        if (opts.hint) b.handle.hint(opts.hint);
        const format = (opts.format ?? (resolveFormat(opts.unit) as Formatter | undefined) ?? defaultFormat) as (
            value: T,
        ) => string;
        const valueEl = el('div', 'dc-monitor-value');
        b.controlEl.append(valueEl);

        if (opts.copy) {
            valueEl.classList.add('dc-monitor-value--copy');
            valueEl.title = 'click to copy';
            let flash: ReturnType<typeof setTimeout> | undefined;
            on(valueEl, 'click', () => {
                navigator.clipboard?.writeText(last);
                valueEl.classList.add('dc-monitor-value--copied');
                clearTimeout(flash);
                flash = setTimeout(() => valueEl.classList.remove('dc-monitor-value--copied'), 700);
            });
        }

        let last = '';
        let lastTime = 0;
        let onscreen = true;
        let observer: IntersectionObserver | undefined;
        const interval = opts.interval ?? 0;

        const update = () => {
            ensureObserver();
            // skip the getter + dom write when hidden (inactive tab / collapsed) or off-screen
            if (!valueEl.isConnected || !onscreen) return;
            const text = format(prop.get());
            if (text !== last) {
                last = text;
                valueEl.textContent = text;
            }
        };

        // pause off-screen readouts in a scrollable panel; re-root if the dock rebuilt the dom
        const ensureObserver = () => {
            if (!b.row.isConnected) return;
            const scroller = b.row.closest('.dc-content');
            if (observer && observer.root === scroller) return;
            observer?.disconnect();
            onscreen = true;
            observer = new IntersectionObserver(
                (entries) => {
                    onscreen = entries[entries.length - 1].isIntersecting;
                    if (onscreen) update();
                },
                { root: scroller, rootMargin: '60px' },
            );
            observer.observe(b.row);
        };

        update();
        b.onDispose(
            ctx.ticker.add((now) => {
                if (interval > 0) {
                    if (now - lastTime < interval) return;
                    lastTime = now;
                }
                update();
            }),
        );
        b.onDispose(() => observer?.disconnect());
        b.render(update);
        return b.handle;
    };
}
