import { base, type Control } from '../control';
import { el, on } from '../dom';

/** a structured log line. plain strings are also accepted and render muted. */
export type Log = { text: string; level?: 'info' | 'warn' | 'error'; time?: number };
export type LogEntry = string | Log;

export type LogOptions = {
    label?: string;
    hint?: string;
    /** scrollback kept in view; older lines drop off the top. cheap even when large. default 1000. */
    max?: number;
    /** min ms between polls. 0 = every frame. default 0. */
    interval?: number;
    /** show a timestamp (from `Log.time`, ms epoch) per line. default false. */
    timestamps?: boolean;
    /** log box height in px. default 140. */
    height?: number;
};

const LINE_H = 18; // fixed row height, virtualization needs a constant

const pad = (n: number) => String(n).padStart(2, '0');
const fmtTime = (t: number) => {
    const d = new Date(t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** a read-only, tail-following log view over your own `(string | Log)[]` array. Windowed-virtualized: only the ~visible rows exist in the dom, so `max` can be huge. */
export function log(opts: LogOptions = {}): Control<LogEntry[]> {
    return (ctx, prop) => {
        const b = base<LogEntry[]>(ctx, prop, opts.label);
        if (opts.hint) b.handle.hint(opts.hint);
        b.row.classList.add('dc-row--stacked');

        const max = opts.max ?? 1000;
        const box = el('div', 'dc-log');
        if (opts.height) box.style.height = `${opts.height}px`;
        const sizer = el('div', 'dc-log-sizer'); // its height drives the scrollbar
        box.append(sizer);
        b.controlEl.append(box);

        // a pool of reusable row elements, grown to fit the viewport
        const pool: HTMLElement[] = [];
        const makeRow = () => {
            const row = el('div', 'dc-log-line', undefined, [el('span', 'dc-log-time'), el('span', 'dc-log-text')]);
            sizer.append(row);
            pool.push(row);
            return row;
        };
        const fillRow = (row: HTMLElement, entry: LogEntry) => {
            const structured = typeof entry !== 'string';
            const level = structured ? entry.level : undefined;
            row.className = `dc-log-line${level ? ` dc-log-line--${level}` : ''}`;
            const timeEl = row.children[0] as HTMLElement;
            const textEl = row.children[1] as HTMLElement;
            if (opts.timestamps && structured && entry.time != null) {
                timeEl.textContent = fmtTime(entry.time);
                timeEl.style.display = '';
            } else {
                timeEl.style.display = 'none';
            }
            const text = structured ? entry.text : entry;
            textEl.textContent = text;
            row.title = text;
        };

        let following = true;
        let onscreen = true;
        let observer: IntersectionObserver | undefined;
        let lastTime = 0;
        const interval = opts.interval ?? 0;

        // render only the rows intersecting the viewport (+ a small buffer)
        const renderWindow = () => {
            if (!box.isConnected || !onscreen) return;
            const arr = prop.get();
            const count = arr ? Math.min(arr.length, max) : 0;
            const offset = arr ? arr.length - count : 0;
            const first = Math.max(0, Math.floor(box.scrollTop / LINE_H) - 4);
            const visible = Math.ceil(box.clientHeight / LINE_H) + 8;
            const need = Math.min(count - first, visible);
            while (pool.length < Math.max(0, need)) makeRow();
            for (let k = 0; k < pool.length; k++) {
                const row = pool[k];
                const idx = first + k;
                if (arr && k < need && idx < count) {
                    fillRow(row, arr[offset + idx]);
                    row.style.transform = `translateY(${idx * LINE_H}px)`;
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            }
        };

        const sync = () => {
            if (!box.isConnected || !onscreen) return;
            if (interval > 0) {
                const now = performance.now();
                if (now - lastTime < interval) return;
                lastTime = now;
            }
            const arr = prop.get();
            const count = arr ? Math.min(arr.length, max) : 0;
            sizer.style.height = `${count * LINE_H}px`;
            if (following) box.scrollTop = box.scrollHeight; // stick to the tail
            renderWindow();
        };

        b.onDispose(
            on(box, 'scroll', () => {
                following = box.scrollHeight - box.scrollTop - box.clientHeight < LINE_H;
                renderWindow();
            }),
        );

        const ensureObserver = () => {
            if (!box.isConnected) return;
            const scroller = box.closest('.dc-content');
            if (observer && observer.root === scroller) return;
            observer?.disconnect();
            onscreen = true;
            observer = new IntersectionObserver(
                (entries) => {
                    onscreen = entries[entries.length - 1].isIntersecting;
                    if (onscreen) sync();
                },
                { root: scroller, rootMargin: '60px' },
            );
            observer.observe(box);
        };

        b.onDispose(
            ctx.ticker.add(() => {
                ensureObserver();
                sync();
            }),
        );
        b.onDispose(() => observer?.disconnect());
        b.render(sync);
        return b.handle;
    };
}
