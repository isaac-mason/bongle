import { base, type Control } from '../control';
import { el, on } from '../dom';
import { fitCanvas } from './canvas';
import { colorResolver, hashHue } from './shared';

/** the minimal shape the flame needs. core/debug's `Frame` matches it. */
export type FlameFrame = {
    /** number of valid spans. */
    count: number;
    /** total frame duration (ms). */
    duration: number;
    /** interned key id per span. */
    key: ArrayLike<number>;
    /** nesting depth per span. */
    depth: ArrayLike<number>;
    /** span start, ms from frame start. */
    start: ArrayLike<number>;
    /** span end, ms from frame start. */
    end: ArrayLike<number>;
};

export type FlameOptions = {
    label?: string;
    /** canvas height in px (default 220). */
    height?: number;
    /** resolve an interned span key id to its display name. */
    name?: (keyId: number) => string;
    /** row height per depth level in px (default 16). */
    rowHeight?: number;
};

const MIN_WINDOW_MS = 0.02; // deepest zoom
const MIN_BAR_PX = 0.5; // cull sub-pixel spans

/** nested bars for one captured frame's span tree. zoom, pan, hover. read-only. */
export function flame(opts: FlameOptions = {}): Control<FlameFrame | null> {
    return (ctx, prop) => {
        const b = base<FlameFrame | null>(ctx, prop, opts.label);
        b.row.classList.add('dc-graph-row');
        b.labelEl.remove();
        b.controlEl.remove();

        const nameOf = opts.name ?? ((id: number) => String(id));
        const rowH = opts.rowHeight ?? 16;
        const color = colorResolver(b.row);

        const valueEl = el('span', 'dc-graph-now');
        const head = el('div', 'dc-graph-head', undefined, [
            el('span', undefined, { textContent: opts.label ?? prop.name ?? 'flame' }),
            valueEl,
        ]);
        const canvas = el('canvas', 'dc-graph');
        canvas.style.height = `${opts.height ?? 220}px`;
        canvas.style.cursor = 'crosshair';
        b.row.append(head, canvas);

        // view window in ms [viewMin, viewMax], refit when the frame changes.
        let viewMin = 0;
        let viewMax = 1;
        let frameKey = -1;
        let hover: [number, number] | null = null;
        let drag: { x: number; min: number; max: number } | null = null;
        let dragged = false;

        const clampView = () => {
            if (viewMax - viewMin < MIN_WINDOW_MS) viewMax = viewMin + MIN_WINDOW_MS;
        };

        const paint = () => {
            if (!canvas.isConnected) return;
            const frame = prop.get();
            const { g, w, h } = fitCanvas(canvas);

            if (!frame || frame.count === 0) {
                valueEl.textContent = 'no capture';
                g.fillStyle = color('muted');
                g.font = '11px ui-monospace, monospace';
                g.textAlign = 'center';
                g.fillText('no frame captured', w / 2, h / 2);
                return;
            }

            // span count + duration is a cheap stand-in for frame identity; a new frame refits the view window.
            const key = frame.count * 131071 + Math.round(frame.duration * 1000);
            if (key !== frameKey) {
                frameKey = key;
                viewMin = 0;
                viewMax = Math.max(frame.duration, MIN_WINDOW_MS);
            }
            clampView();

            valueEl.textContent = `${frame.duration.toFixed(2)} ms · ${frame.count} spans`;

            const span = viewMax - viewMin;
            const xOf = (t: number) => ((t - viewMin) / span) * w;

            let hitName = '';
            let hitMs = 0;
            let hitPct = 0;

            for (let i = 0; i < frame.count; i++) {
                const spanStart = frame.start[i]!;
                const spanEnd = frame.end[i]!;
                if (spanEnd <= viewMin || spanStart >= viewMax) continue; // off-screen
                const x0 = Math.max(0, xOf(spanStart));
                const x1 = Math.min(w, xOf(spanEnd));
                const barW = x1 - x0;
                if (barW < MIN_BAR_PX) continue;
                const y = frame.depth[i]! * rowH;
                if (y > h) continue;

                const name = nameOf(frame.key[i]!);
                const hue = hashHue(name);
                const under = hover !== null && hover[0] >= x0 && hover[0] < x1 && hover[1] >= y && hover[1] < y + rowH;
                g.fillStyle = `hsl(${hue} 55% ${under ? 62 : 46}%)`;
                g.fillRect(x0, y, Math.max(1, barW - 1), rowH - 1);

                if (under) {
                    hitName = name;
                    hitMs = spanEnd - spanStart;
                    hitPct = (hitMs / frame.duration) * 100;
                }

                if (barW > 34) {
                    g.fillStyle = `hsl(${hue} 65% 90%)`;
                    g.font = '10px ui-monospace, monospace';
                    g.textAlign = 'left';
                    g.textBaseline = 'middle';
                    g.save();
                    g.beginPath();
                    g.rect(x0 + 2, y, barW - 3, rowH - 1);
                    g.clip();
                    g.fillText(`${name} ${(spanEnd - spanStart).toFixed(1)}`, x0 + 3, y + (rowH - 1) / 2);
                    g.restore();
                }
            }

            if (hover && hitName) {
                const text = `${hitName}  ${hitMs.toFixed(3)} ms  ${hitPct.toFixed(1)}%`;
                g.font = '10px ui-monospace, monospace';
                const textW = g.measureText(text).width + 10;
                let tx = hover[0] + 12;
                if (tx + textW > w) tx = hover[0] - textW - 12;
                const ty = Math.min(h - 18, hover[1] + 8);
                g.fillStyle = 'rgba(20,22,27,0.95)';
                g.fillRect(tx, ty, textW, 15);
                g.strokeStyle = color('border');
                g.strokeRect(tx, ty, textW, 15);
                g.fillStyle = color('fg');
                g.textAlign = 'left';
                g.textBaseline = 'middle';
                g.fillText(text, tx + 5, ty + 8);
            }
        };

        b.onDispose(
            on(
                canvas,
                'wheel',
                (e) => {
                    const ev = e as WheelEvent;
                    ev.preventDefault();
                    const frame = prop.get();
                    if (!frame) return;
                    const w = canvas.clientWidth || 1;
                    const span = viewMax - viewMin;
                    const cursorMs = viewMin + (ev.offsetX / w) * span;
                    const factor = ev.deltaY < 0 ? 0.82 : 1 / 0.82;
                    viewMin = Math.max(0, cursorMs - (cursorMs - viewMin) * factor);
                    viewMax = Math.min(Math.max(frame.duration, MIN_WINDOW_MS), cursorMs + (viewMax - cursorMs) * factor);
                    clampView();
                    paint();
                },
                { passive: false },
            ),
        );
        b.onDispose(
            on(canvas, 'pointerdown', (e) => {
                const ev = e as PointerEvent;
                canvas.setPointerCapture(ev.pointerId);
                drag = { x: ev.offsetX, min: viewMin, max: viewMax };
                dragged = false;
            }),
        );
        b.onDispose(
            on(canvas, 'pointermove', (e) => {
                const ev = e as PointerEvent;
                hover = [ev.offsetX, ev.offsetY];
                if (drag) {
                    const w = canvas.clientWidth || 1;
                    const span = drag.max - drag.min;
                    const dt = ((ev.offsetX - drag.x) / w) * span;
                    if (Math.abs(ev.offsetX - drag.x) > 2) dragged = true;
                    const frame = prop.get();
                    const duration = frame ? Math.max(frame.duration, MIN_WINDOW_MS) : span;
                    let min = drag.min - dt;
                    let max = drag.max - dt;
                    if (min < 0) {
                        max -= min;
                        min = 0;
                    }
                    if (max > duration) {
                        min -= max - duration;
                        max = duration;
                    }
                    viewMin = Math.max(0, min);
                    viewMax = Math.min(duration, max);
                }
                paint();
            }),
        );
        const endDrag = (e: Event) => {
            const ev = e as PointerEvent;
            if (drag) canvas.releasePointerCapture?.(ev.pointerId);
            drag = null;
        };
        b.onDispose(on(canvas, 'pointerup', endDrag));
        b.onDispose(on(canvas, 'pointercancel', endDrag));
        b.onDispose(
            on(canvas, 'pointerleave', () => {
                hover = null;
                paint();
            }),
        );
        // swallow the click that ends a pan so it can't bubble to the panel chrome.
        b.onDispose(
            on(canvas, 'click', (e) => {
                if (dragged) {
                    e.stopPropagation();
                    e.preventDefault();
                    dragged = false;
                }
            }),
        );

        paint();
        b.onDispose(ctx.ticker.add(() => paint()));
        b.render(paint);
        return b.handle;
    };
}
