import type { Base, Context } from '../control';
import { on } from '../dom';

/** size a canvas to its css box at device-pixel resolution, clear it, and return the 2d ctx + css size. */
export function fitCanvas(canvas: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } {
    const g = canvas.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
}

export type CanvasMonitorOptions = {
    /** minimum ms between ticks. 0 = every frame. */
    interval?: number;
    /** runs every (throttled) tick, visible or not — keep ring buffers warm here. */
    tick?: () => void;
    /** draws the widget. only runs when on-screen and in an active tab. `hover` is the
     * cursor position `[x, y]` in css px while the pointer is over the canvas, else null. */
    paint: (g: CanvasRenderingContext2D, w: number, h: number, hover: [number, number] | null) => void;
    /** overlay a crosshair reading the value under the cursor (data keeps flowing). */
    hover?: boolean;
};

/**
 * the shared scaffold for every canvas watch widget. DPR-correct sizing, clears
 * each frame, and pauses painting when the canvas is off-screen or in an inactive
 * tab. `tick` still runs while hidden so history stays continuous; only `paint` pauses.
 */
export function canvasMonitor<T>(ctx: Context, b: Base<T>, canvas: HTMLCanvasElement, opts: CanvasMonitorOptions): void {
    const g = canvas.getContext('2d')!;
    let onscreen = true;
    let observer: IntersectionObserver | undefined;
    let lastTime = 0;
    let lastRoot = 0;
    const interval = opts.interval ?? 0;

    // css size is tracked by a ResizeObserver so paint never reads layout (clientWidth
    // forces a reflow — costly with many charts). dpr changes are caught in paint by a
    // cheap number compare, not a layout read.
    let cssW = 1;
    let cssH = 1;
    let dpr = window.devicePixelRatio || 1;
    const resize = () => {
        cssW = canvas.clientWidth || 1;
        cssH = canvas.clientHeight || 1;
        dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    b.onDispose(() => ro.disconnect());

    let hover: [number, number] | null = null;
    const paint = () => {
        if (!canvas.isConnected || !onscreen) return;
        if (dpr !== (window.devicePixelRatio || 1) || canvas.width === 0) resize();
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, cssW, cssH);
        opts.paint(g, cssW, cssH, hover);
    };

    if (opts.hover) {
        canvas.style.cursor = 'crosshair';
        // data keeps flowing; hovering just records the cursor and repaints the overlay
        b.onDispose(
            on(canvas, 'pointermove', (e) => {
                const p = e as PointerEvent;
                hover = [p.offsetX, p.offsetY];
                paint();
            }),
        );
        b.onDispose(
            on(canvas, 'pointerleave', () => {
                hover = null;
                paint();
            }),
        );
    }

    // the dock rebuilds the dom on layout changes, so the observer re-roots when its
    // scroll container changes. the closest() walk is throttled — re-rooting only
    // matters after a (rare) dock rebuild, not every frame.
    const ensureObserver = () => {
        if (!canvas.isConnected) return;
        const now = performance.now();
        if (observer && now - lastRoot < 500) return;
        lastRoot = now;
        const scroller = canvas.closest('.dc-content');
        if (observer && observer.root === scroller) return;
        observer?.disconnect();
        onscreen = true;
        observer = new IntersectionObserver(
            (entries) => {
                onscreen = entries[entries.length - 1].isIntersecting;
                if (onscreen) paint();
            },
            { root: scroller, rootMargin: '60px' },
        );
        observer.observe(canvas);
    };

    b.onDispose(
        ctx.ticker.add((now) => {
            if (interval > 0) {
                if (now - lastTime < interval) return;
                lastTime = now;
            }
            ensureObserver();
            opts.tick?.();
            paint();
        }),
    );
    b.onDispose(() => observer?.disconnect());
    b.render(paint);
}

export type WatchOptions = {
    /** minimum ms between updates. 0 = every frame. */
    interval?: number;
    /** reflect the prop into the dom. skipped while off-screen / in an inactive tab. */
    update: () => void;
};

/**
 * the dom counterpart to canvasMonitor for widgets that render html (bars, stat).
 * throttles, pauses off-screen, and re-roots its observer on dock rebuilds.
 */
export function watch<T>(ctx: Context, b: Base<T>, target: HTMLElement, opts: WatchOptions): void {
    let onscreen = true;
    let observer: IntersectionObserver | undefined;
    let lastTime = 0;
    let lastRoot = 0;
    const interval = opts.interval ?? 0;

    const run = () => {
        if (!target.isConnected || !onscreen) return;
        opts.update();
    };

    const ensureObserver = () => {
        if (!target.isConnected) return;
        const now = performance.now();
        if (observer && now - lastRoot < 500) return;
        lastRoot = now;
        const scroller = target.closest('.dc-content');
        if (observer && observer.root === scroller) return;
        observer?.disconnect();
        onscreen = true;
        observer = new IntersectionObserver(
            (entries) => {
                onscreen = entries[entries.length - 1].isIntersecting;
                if (onscreen) run();
            },
            { root: scroller, rootMargin: '60px' },
        );
        observer.observe(target);
    };

    b.onDispose(
        ctx.ticker.add((now) => {
            if (interval > 0) {
                if (now - lastTime < interval) return;
                lastTime = now;
            }
            ensureObserver();
            run();
        }),
    );
    b.onDispose(() => observer?.disconnect());
    b.render(run);
}
