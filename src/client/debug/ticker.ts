// timestamp is ms: rAF time in auto mode, whatever `dashboard.update(now?)` passed in manual mode.
export type TickHandler = (now: number) => void;

export type Ticker = {
    /** register a per-frame handler; returns a disposer that removes it. */
    add(handler: TickHandler): () => void;
    remove(handler: TickHandler): void;
    /** run every registered handler once with `now`. drives manual mode; the rAF loop calls it too. */
    tick(now?: number): void;
    /** hold the rAF loop without dropping handlers, e.g. while the ui is out of view:
     *  nothing samples or repaints until it resumes. only `tick()` drives a paused ticker. */
    pause(paused?: boolean): void;
    destroy(): void;
};

export function createTicker(opts: { manual?: boolean } = {}): Ticker {
    const handlers = new Set<TickHandler>();
    const manual = opts.manual ?? false;
    let raf = 0;
    let paused = false;

    const tick = (now: number = performance.now()) => {
        // a throwing handler must not kill the rAF loop for every other widget.
        for (const handler of handlers) {
            try {
                handler(now);
            } catch (err) {
                console.warn('[bongle] debug: a widget handler threw, skipped', err);
            }
        }
    };

    const start = () => {
        if (manual || paused || raf) return;
        const loop = (t: number) => {
            tick(t);
            raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
    };

    const stop = () => {
        if (!raf) return;
        cancelAnimationFrame(raf);
        raf = 0;
    };

    const remove = (handler: TickHandler) => {
        handlers.delete(handler);
        if (handlers.size === 0) stop();
    };

    return {
        add(handler) {
            handlers.add(handler);
            start();
            return () => remove(handler);
        },
        remove,
        tick,
        pause(next = true) {
            paused = next;
            if (paused) stop();
            else if (handlers.size) start();
        },
        destroy() {
            handlers.clear();
            stop();
        },
    };
}
